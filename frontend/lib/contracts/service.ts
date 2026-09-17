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
  networkName,
  sdkFor,
  toCalldataAddress,
  type GenLayerClient,
} from "@/lib/genlayer/client";
import type { GenLayerChain, TransactionHash } from "genlayer-js/types";

/** What both of genlayer-js's fee estimators return, in the part we use. */
type FeeEstimate = {
  distribution: unknown;
  messageAllocations: unknown;
  feeValue: unknown;
};
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


  /**
   * The execution results that mean "the contract ran and returned".
   *
   * Consensus v0.6 renamed this: v0.5 reported "SUCCESS", v0.6 reports
   * "FINISHED_WITH_RETURN". Both are accepted because a v0.5 node still
   * answers with the old name. Nothing else counts — v0.6 also defines
   * FINISHED_WITH_ERROR, TIMEOUT, NONDET_DISAGREE and DETERMINISTIC_VIOLATION,
   * and every one of those is a failed write.
   */
  private static readonly SUCCESS_RESULTS = ["SUCCESS", "FINISHED_WITH_RETURN"];

  /**
   * Quote the fee for one write. TWO layers, and a loud failure.
   *
   * Consensus v0.6 CHARGES FEES, and a transaction submitted without one is
   * rejected by the consensus contract with `FeeValueMustBeNonZero` before the
   * contract is reached. This console's write path predates that: it sent
   * `value: 0n` and no fee at all, correct on the gasless v0.5 networks and
   * silently fatal on Studio Next.
   *
   * `estimateTransactionFeesForWrite` sizes the fee to this exact call, so it
   * is tried first. But it works by SIMULATING the call, which means it fails
   * whenever the call itself would revert — and on Studio Next it also fails
   * for writes that are perfectly fine (see the known issue in the README).
   * `estimateTransactionFees` simulates nothing and survives both cases, so it
   * is the fallback.
   *
   * If neither answers on a v0.6 network, this THROWS. An earlier version
   * returned null here and sent the transaction anyway, which produced exactly
   * the `FeeValueMustBeNonZero` revert this method exists to prevent — paying
   * gas to be told what we already knew. A write we know the network will
   * refuse is not worth sending.
   */
  private async quoteFees(
    address: string,
    functionName: string,
    args: unknown[],
  ): Promise<unknown | null> {
    if (sdkFor(networkName()) !== "v2") return null;

    const client = this.client as unknown as {
      estimateTransactionFeesForWrite?: (input: {
        address: string;
        functionName: string;
        args: unknown[];
      }) => Promise<FeeEstimate>;
      estimateTransactionFees?: () => Promise<FeeEstimate>;
    };

    const shape = (estimate: FeeEstimate) => ({
      distribution: estimate.distribution,
      messageAllocations: estimate.messageAllocations,
      feeValue: estimate.feeValue,
    });

    try {
      const perCall = await client.estimateTransactionFeesForWrite?.({
        address,
        functionName,
        args,
      });
      if (perCall) return shape(perCall);
    } catch {
      /* simulation-based, so it fails on a call that would revert; fall back */
    }

    try {
      const blanket = await client.estimateTransactionFees?.();
      if (blanket) return shape(blanket);
    } catch {
      /* nothing left to try */
    }

    throw new Error(
      "Could not get a fee quote from the network, and this network rejects " +
        "any transaction without one. Nothing was sent. Retry in a moment — " +
        "if it persists, the fee estimator on this node is down.",
    );
  }

  private async write(
    address: string,
    functionName: string,
    args: unknown[],
  ): Promise<WriteOutcome> {
    const fees = await this.quoteFees(address, functionName, args);

    const hash = (await this.client.writeContract({
      address: address as `0x${string}`,
      functionName,
      args: args as never[],
      value: 0n,
      ...(fees ? { fees } : {}),
    } as never)) as string;

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
    // Nodes disagree about where the lifecycle status lives: a separate
    // `statusName`, a name in `status`, the numeric enum, or a lowercase
    // `lifecycle.state`. Reading one spelling and trusting it is how a good
    // transaction gets reported as a failure.
    const lifecycle = (receipt as { lifecycle?: { state?: unknown } }).lifecycle;
    const statusName =
      receipt.statusName ??
      (typeof lifecycle?.state === "string" ? lifecycle.state.toUpperCase() : null) ??
      String(receipt.status ?? "UNKNOWN");

    // Lifecycle status is not success. Only an executed contract counts.
    const succeeded = AutoShieldService.SUCCESS_RESULTS.includes(executionResult);

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
