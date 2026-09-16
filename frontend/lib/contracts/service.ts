/**
 * The only place in the console that talks to the chain.
 *
 * Components never call `readContract` or `writeContract`. They go through an
 * `AutoShieldService`, which owns address configuration, argument encoding,
 * receipt interpretation and the write lifecycle.
 *
 * Two rules this layer enforces on behalf of the whole app:
 *
 *  1. A write is only ever reported as confirmed when the node says the
 *     contract EXECUTED successfully. On GenLayer a transaction can reach
 *     ACCEPTED/FINALIZED while the contract reverted and no state changed, so
 *     lifecycle status alone is never treated as success.
 *  2. Adjudication results are always re-read from the chain afterwards. The
 *     value a write returns is never trusted as the authoritative outcome.
 */

import {
  TransactionStatus,
  toCalldataAddress,
  type GenLayerClient,
} from "@/lib/genlayer/client";
import type { GenLayerChain, TransactionHash } from "genlayer-js/types";
import {
  decodeConfig,
  decodeIncident,
  decodeIncidentIds,
  decodeStatus,
  decodeTelemetry,
  toLevel,
} from "@/lib/contracts/decode";
import type {
  ConsensusOutcome,
  Incident,
  IncidentCategory,
  ProtocolStatus,
  ProtocolTelemetry,
  ResponseLevel,
  ShieldConfig,
  ValidatorStatus,
} from "@/lib/types";

export interface ContractAddresses {
  protocol: string;
  shield: string;
}

export function addressesFromEnv(): ContractAddresses | null {
  const protocol = process.env.NEXT_PUBLIC_PROTOCOL_ADDRESS ?? "";
  const shield = process.env.NEXT_PUBLIC_AUTOSHIELD_ADDRESS ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(protocol) || !/^0x[0-9a-fA-F]{40}$/.test(shield)) {
    return null;
  }
  return { protocol, shield };
}

/** What a completed write actually did, separated from how it settled. */
export interface WriteOutcome {
  hash: string;
  statusName: string;
  executionResult: string;
  succeeded: boolean;
  error: string | null;
  consensus: ConsensusOutcome | null;
  returnValue: unknown;
}

type Receipt = {
  statusName?: string;
  status?: string | number;
  consensus_data?: {
    final?: boolean;
    leader_receipt?: Array<Record<string, unknown>>;
    validators?: Array<Record<string, unknown>>;
    votes?: Record<string, string>;
  };
};

function leaderReceipt(receipt: Receipt): Record<string, unknown> | null {
  const leaders = receipt.consensus_data?.leader_receipt;
  return Array.isArray(leaders) && leaders.length > 0 ? (leaders[0] ?? null) : null;
}

function leaderError(receipt: Receipt): string | null {
  const leader = leaderReceipt(receipt);
  if (!leader) return null;
  const genvm = leader.genvm_result;
  if (genvm && typeof genvm === "object") {
    const stderr = (genvm as Record<string, unknown>).stderr;
    if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  }
  return null;
}

/** Build the validator panel from what the receipt genuinely reports. */
export function readConsensus(receipt: Receipt): ConsensusOutcome | null {
  const data = receipt.consensus_data;
  if (!data) return null;

  const votes = data.votes ?? {};
  const validatorEntries = Array.isArray(data.validators) ? data.validators : [];
  const addresses = Object.keys(votes);
  const count = Math.max(addresses.length, validatorEntries.length);
  if (count === 0) return null;

  const validators: ValidatorStatus[] = [];
  for (let index = 0; index < count; index += 1) {
    const address = addresses[index] ?? `validator-${index}`;
    const entry = validatorEntries[index];
    const executionResult =
      entry && typeof entry.execution_result === "string" ? entry.execution_result : null;
    const vote = votes[address];

    let phase: ValidatorStatus["phase"] = "evaluating";
    if (executionResult === "ERROR") phase = "failed";
    else if (vote === "agree") phase = "agreed";
    else if (vote === "disagree") phase = "disagreed";

    validators.push({ index, address, phase, executionResult });
  }

  const agreeCount = validators.filter((v) => v.phase === "agreed").length;
  return {
    validators,
    agreeCount,
    totalCount: validators.length,
    finalized: Boolean(data.final),
    fromChain: true,
  };
}

export class AutoShieldService {
  constructor(
    private readonly client: GenLayerClient<GenLayerChain>,
    private readonly addresses: ContractAddresses,
  ) {}

  get contractAddresses(): ContractAddresses {
    return this.addresses;
  }

  // ---------------------------------------------------------------- reads

  async protocolStatus(): Promise<ProtocolStatus> {
    return decodeStatus(
      await this.client.readContract({
        address: this.addresses.protocol as `0x${string}`,
        functionName: "get_status",
        args: [],
      }),
    );
  }

  async protocolTelemetry(): Promise<ProtocolTelemetry> {
    return decodeTelemetry(
      await this.client.readContract({
        address: this.addresses.protocol as `0x${string}`,
        functionName: "telemetry",
        args: [],
      }),
    );
  }

  async shieldConfig(): Promise<ShieldConfig> {
    return decodeConfig(
      await this.client.readContract({
        address: this.addresses.shield as `0x${string}`,
        functionName: "get_config",
        args: [],
      }),
    );
  }

  /**
   * Is this address on the reporter allowlist?
   *
   * Asked of the contract rather than inferred from configuration, because the
   * allowlist is the thing that actually decides whether a write will succeed,
   * and the owner can change it at any time.
   */
  async isReporter(who: string): Promise<boolean> {
    const result = await this.client.readContract({
      address: this.addresses.shield as `0x${string}`,
      functionName: "is_reporter",
      args: [toCalldataAddress(who)],
    });
    return result === true;
  }

  async incidentIds(): Promise<string[]> {
    return decodeIncidentIds(
      await this.client.readContract({
        address: this.addresses.shield as `0x${string}`,
        functionName: "list_incidents",
        args: [],
      }),
    );
  }

  async incident(incidentId: string): Promise<Incident> {
    return decodeIncident(
      await this.client.readContract({
        address: this.addresses.shield as `0x${string}`,
        functionName: "get_incident",
        args: [incidentId],
      }),
    );
  }

  async incidents(limit = 25): Promise<Incident[]> {
    const ids = await this.incidentIds();
    const recent = ids.slice(-limit).reverse();
    return Promise.all(recent.map((id) => this.incident(id)));
  }

  /**
   * Ask the CONTRACT what level a severity/signal pair maps to.
   *
   * This is `derive_level` itself, exposed as a view. The console never
   * reimplements the policy — if it did, the explanation shown to the operator
   * could drift from the rule that actually governs the protocol.
   */
  async previewLevel(severity: number, signalsBits: number): Promise<ResponseLevel | ""> {
    return toLevel(
      await this.client.readContract({
        address: this.addresses.shield as `0x${string}`,
        functionName: "preview_level",
        args: [severity, signalsBits],
      }),
    );
  }

  // --------------------------------------------------------------- writes

  private async write(
    address: string,
    functionName: string,
    args: unknown[],
  ): Promise<WriteOutcome> {
    const hash = (await this.client.writeContract({
      address: address as `0x${string}`,
      functionName,
      args: args as never[],
      value: 0n,
    })) as string;

    // `TransactionHash` is a branded `0x${string}`; the brand is compile-time
    // only, so the runtime value is exactly the hex string we just received.
    const receipt = (await this.client.waitForTransactionReceipt({
      hash: hash as unknown as TransactionHash,
      status: TransactionStatus.ACCEPTED,
      interval: 700,
      retries: 90,
    })) as Receipt;

    const leader = leaderReceipt(receipt);
    const executionResult =
      leader && typeof leader.execution_result === "string"
        ? leader.execution_result
        : "UNKNOWN";
    const statusName = receipt.statusName ?? String(receipt.status ?? "UNKNOWN");

    // Lifecycle status is not success. Only an executed contract counts.
    const succeeded = executionResult === "SUCCESS";

    return {
      hash,
      statusName,
      executionResult,
      succeeded,
      error: succeeded ? null : (leaderError(receipt) ?? `Execution ${executionResult}`),
      consensus: readConsensus(receipt),
      returnValue: leader?.result ?? null,
    };
  }

  /** Wait for the asynchronous `emit` follow-up a response triggers. */
  async waitForTriggered(hash: string): Promise<void> {
    try {
      const triggered = await this.client.getTriggeredTransactionIds({
        hash: hash as unknown as TransactionHash,
      });
      await Promise.all(
        triggered.map((id) =>
          this.client.waitForTransactionReceipt({
            hash: id,
            status: TransactionStatus.ACCEPTED,
            interval: 700,
            retries: 90,
          }),
        ),
      );
    } catch {
      // The follow-up is observable on the protocol's own state either way;
      // polling will pick it up. Never fail the user action on this.
    }
  }

  reportIncident(input: {
    category: IncidentCategory;
    observedAtTs: number;
    evidenceHash: string;
    evidenceUri: string;
    metadataJson: string;
  }): Promise<WriteOutcome> {
    return this.write(this.addresses.shield, "report_incident", [
      input.category,
      input.observedAtTs,
      input.evidenceHash,
      input.evidenceUri,
      input.metadataJson,
    ]);
  }

  adjudicate(incidentId: string): Promise<WriteOutcome> {
    return this.write(this.addresses.shield, "adjudicate", [incidentId]);
  }

  executeResponse(incidentId: string): Promise<WriteOutcome> {
    return this.write(this.addresses.shield, "execute_response", [incidentId]);
  }

  expireIncident(incidentId: string): Promise<WriteOutcome> {
    return this.write(this.addresses.shield, "expire_incident", [incidentId]);
  }

  setReporter(who: string, allowed: boolean): Promise<WriteOutcome> {
    return this.write(this.addresses.shield, "set_reporter", [
      toCalldataAddress(who),
      allowed,
    ]);
  }

  clearResponse(): Promise<WriteOutcome> {
    return this.write(this.addresses.protocol, "clear_response", []);
  }

  // ------------------------------------------- demo simulation surface
  // Owner-only methods on the demo protocol. They move only the demo
  // protocol's own reported telemetry; they implement no attack and touch
  // nothing outside this controlled contract.

  simulateOracleMove(magnitudeBps: number, direction: "UP" | "DOWN"): Promise<WriteOutcome> {
    return this.write(this.addresses.protocol, "simulate_oracle_move", [
      magnitudeBps,
      direction,
    ]);
  }

  simulateBorrowSpike(windowVolumeBps: number): Promise<WriteOutcome> {
    return this.write(this.addresses.protocol, "simulate_borrow_spike", [windowVolumeBps]);
  }

  simulateLiquidityDrain(drainBps: number): Promise<WriteOutcome> {
    return this.write(this.addresses.protocol, "simulate_liquidity_drain", [drainBps]);
  }

  simulateTxBurst(
    txCount: number,
    uniqueSenders: number,
    topSenderShareBps: number,
  ): Promise<WriteOutcome> {
    return this.write(this.addresses.protocol, "simulate_tx_burst", [
      txCount,
      uniqueSenders,
      topSenderShareBps,
    ]);
  }

  resetSimulation(): Promise<WriteOutcome> {
    return this.write(this.addresses.protocol, "reset_simulation", []);
  }
}
