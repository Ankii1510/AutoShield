/**
 * DEMO MODE — a fully simulated AutoShield, with no chain behind it.
 *
 * This file exists so the console can be demonstrated without a running node.
 * It is deliberately quarantined: nothing here is imported by the chain path,
 * and everything it produces is tagged `simulated: true` so the UI can label
 * it. In particular `ConsensusOutcome.fromChain` is false, so the validator
 * panel says SIMULATED rather than dressing a scripted result up as consensus.
 *
 * `deriveLevelReference` below mirrors the contract's `derive_level()`. In
 * chain mode the console NEVER uses it — it calls the contract's own
 * `preview_level` view, so the explanation shown to an operator can never drift
 * from the rule that actually governs the protocol. The mirror is for offline
 * demo only, and the test suite pins it against the documented rules.
 */

import { demoEvidenceHash, type Scenario } from "@/lib/demo/scenarios";
import { decodeSignals, encodeSignals } from "@/lib/contracts/decode";
import {
  DECISIVE_SIGNALS,
  type ConsensusOutcome,
  type Incident,
  type ProtocolStatus,
  type ProtocolTelemetry,
  type ResponseLevel,
  type ShieldConfig,
  type SignalFlags,
  type SignalName,
  type ValidatorStatus,
} from "@/lib/types";

export const PROTECT_SEVERITY_THRESHOLD = 40;
export const HALT_SEVERITY_THRESHOLD = 75;
export const PROTECT_TTL_SECONDS = 3600;
export const HALT_TTL_SECONDS = 1800;
export const HALT_DECAY_TO_RESTRICTED_SECONDS = 1800;

/**
 * Mirror of the contract's deterministic policy, for demo mode only.
 *
 *   1. condition_resolved  => SAFE at any severity
 *   2. HALT requires severity >= 75 AND a decisive signal AND no inconsistency
 *   3. severity >= 40      => PROTECT
 *   4. otherwise           => SAFE
 */
export function deriveLevelReference(
  severity: number,
  signals: SignalFlags,
): ResponseLevel {
  if (signals.condition_resolved) return "SAFE";

  const corroborated = DECISIVE_SIGNALS.some((name: SignalName) => signals[name]);
  const inconsistent = signals.evidence_inconsistent;

  if (severity >= HALT_SEVERITY_THRESHOLD && corroborated && !inconsistent) return "HALT";
  if (severity >= PROTECT_SEVERITY_THRESHOLD) return "PROTECT";
  return "SAFE";
}

const ONE_ATTO = 10n ** 18n;

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

interface DemoState {
  mode: ProtocolStatus["mode"];
  modeDeadlineTs: number;
  activeIncidentId: string;
  consecutiveHalts: number;
  telemetry: ProtocolTelemetry;
  incidents: Incident[];
  counter: number;
}

function baselineTelemetry(): ProtocolTelemetry {
  return {
    priceAtto: ONE_ATTO,
    baselineAtto: ONE_ATTO,
    deviationBps: 0,
    secondsSinceUpdate: 4,
    totalDepositsAtto: 1_250_000n * ONE_ATTO,
    totalBorrowedAtto: 610_000n * ONE_ATTO,
    availableLiquidityAtto: 640_000n * ONE_ATTO,
    utilisationBps: 4880,
    windowVolumeBps: 0,
    liquidityDeltaBps: 0,
    txCount: 0,
    uniqueSenders: 0,
    topSenderShareBps: 0,
    mode: "NORMAL",
    nowTs: nowTs(),
  };
}

/** How a simulated evaluator would score a scenario. Scripted, not inferred. */
const OUTLOOK_SEVERITY: Record<Scenario["outlook"], number> = {
  benign: 12,
  suspicious: 58,
  critical: 91,
};

export class DemoEngine {
  private state: DemoState = {
    mode: "NORMAL",
    modeDeadlineTs: 0,
    activeIncidentId: "",
    consecutiveHalts: 0,
    telemetry: baselineTelemetry(),
    incidents: [],
    counter: 0,
  };

  /** Lazy decay, mirroring the contract: HALTED -> RESTRICTED -> NORMAL. */
  private settle(): void {
    const now = nowTs();
    if (this.state.mode === "NORMAL") return;
    if (now < this.state.modeDeadlineTs) return;

    if (this.state.mode === "HALTED") {
      const decayed = this.state.modeDeadlineTs + HALT_DECAY_TO_RESTRICTED_SECONDS;
      if (now < decayed) {
        this.state.mode = "RESTRICTED";
        this.state.modeDeadlineTs = decayed;
        return;
      }
    }
    this.state.mode = "NORMAL";
    this.state.modeDeadlineTs = 0;
    this.state.activeIncidentId = "";
    this.state.consecutiveHalts = 0;
  }

  status(): ProtocolStatus {
    this.settle();
    const now = nowTs();
    return {
      mode: this.state.mode,
      storedMode: this.state.mode,
      modeDeadlineTs: this.state.modeDeadlineTs,
      secondsRemaining: this.state.modeDeadlineTs
        ? Math.max(0, this.state.modeDeadlineTs - now)
        : 0,
      activeIncidentId: this.state.activeIncidentId,
      consecutiveHalts: this.state.consecutiveHalts,
      guardAddress: "0xDEM0AutoShie1dGuard000000000000000000000",
      owner: "0xDEM0Owner000000000000000000000000000000",
      nowTs: now,
      borrowEnabled: this.state.mode === "NORMAL",
      supplyEnabled: this.state.mode !== "HALTED",
      withdrawEnabled: this.state.mode !== "HALTED",
      repayEnabled: true,
    };
  }

  telemetry(): ProtocolTelemetry {
    this.settle();
    return { ...this.state.telemetry, mode: this.state.mode, nowTs: nowTs() };
  }

  config(): ShieldConfig {
    return {
      owner: "0xDEM0Owner000000000000000000000000000000",
      evaluator: "0xDEM0Evaluator00000000000000000000000000",
      protocolAddress: "0xDEM0Protoco1000000000000000000000000000",
      paused: false,
      protectSeverityThreshold: PROTECT_SEVERITY_THRESHOLD,
      haltSeverityThreshold: HALT_SEVERITY_THRESHOLD,
      signalNames: [
        "price_manipulation",
        "liquidity_drain",
        "borrow_anomaly",
        "coordinated_activity",
        "evidence_inconsistent",
        "condition_resolved",
      ],
      allSignalsMask: 63,
      decisiveSignalsMask: 15,
      freshnessWindowSeconds: 600,
      evaluationWindowSeconds: 900,
      executionWindowSeconds: 300,
      protectTtlSeconds: PROTECT_TTL_SECONDS,
      haltTtlSeconds: HALT_TTL_SECONDS,
      reportCooldownSeconds: 60,
      maxOpenIncidents: 8,
      maxReportsPerWindow: 20,
      openIncidentCount: this.state.incidents.filter((i) =>
        ["READY", "EVALUATED"].includes(i.status),
      ).length,
      incidentCount: this.state.incidents.length,
    };
  }

  incidents(): Incident[] {
    return [...this.state.incidents].reverse();
  }

  incident(id: string): Incident | undefined {
    return this.state.incidents.find((i) => i.incidentId === id);
  }

  applyScenario(scenario: Scenario): void {
    const next = baselineTelemetry();
    for (const step of scenario.steps) {
      switch (step.kind) {
        case "reset":
          break;
        case "oracle": {
          const delta = (next.baselineAtto * BigInt(step.magnitudeBps)) / 10_000n;
          next.priceAtto =
            step.direction === "UP" ? next.baselineAtto + delta : next.baselineAtto - delta;
          next.deviationBps = step.magnitudeBps;
          next.secondsSinceUpdate = 2;
          break;
        }
        case "borrow":
          next.windowVolumeBps = step.windowVolumeBps;
          break;
        case "liquidity":
          next.liquidityDeltaBps = step.drainBps;
          break;
        case "tx":
          next.txCount = step.txCount;
          next.uniqueSenders = step.uniqueSenders;
          next.topSenderShareBps = step.topSenderShareBps;
          break;
      }
    }
    this.state.telemetry = next;
  }

  resetSimulation(): void {
    this.state.telemetry = baselineTelemetry();
  }

  reportIncident(scenario: Scenario): Incident {
    this.state.counter += 1;
    const id = `INC-${this.state.counter}`;
    const now = nowTs();
    const incident: Incident = {
      incidentId: id,
      protocol: this.config().protocolAddress,
      reporter: "0xDEM0Reporter000000000000000000000000000",
      status: "READY",
      evidence: {
        category: scenario.category,
        evidenceHash: demoEvidenceHash(scenario.id, this.state.counter),
        evidenceUri: `ipfs://demo/${scenario.id}/${this.state.counter}`,
        metadataJson: JSON.stringify(scenario.claimed),
        observedAtTs: now - 12,
      },
      createdAtTs: now,
      evaluation: null,
      level: "",
      deadlineTs: 0,
      executed: false,
    };
    this.state.incidents.push(incident);
    return incident;
  }

  /** The scripted evaluator verdict for a scenario. */
  verdictFor(scenario: Scenario): { severity: number; signalsBits: number } {
    const flags: Partial<SignalFlags> = {};
    for (const name of scenario.likelySignals) flags[name] = true;
    return {
      severity: OUTLOOK_SEVERITY[scenario.outlook],
      signalsBits: encodeSignals(flags),
    };
  }

  adjudicate(
    incidentId: string,
    severity: number,
    signalsBits: number,
  ): Incident | undefined {
    const incident = this.state.incidents.find((i) => i.incidentId === incidentId);
    if (!incident || incident.status !== "READY") return undefined;

    const signals = decodeSignals(signalsBits);
    const level = deriveLevelReference(severity, signals);
    const now = nowTs();

    incident.evaluation = { severity, signalsBits, signals, evaluatedAtTs: now };
    incident.level = level;

    if (level === "SAFE") {
      incident.status = "DISMISSED";
      incident.deadlineTs = 0;
    } else {
      incident.status = "EVALUATED";
      incident.deadlineTs =
        now + (level === "HALT" ? HALT_TTL_SECONDS : PROTECT_TTL_SECONDS);
    }
    return incident;
  }

  executeResponse(incidentId: string): Incident | undefined {
    const incident = this.state.incidents.find((i) => i.incidentId === incidentId);
    if (!incident || incident.status !== "EVALUATED") return undefined;
    if (incident.level !== "PROTECT" && incident.level !== "HALT") return undefined;

    incident.status = "APPLIED";
    incident.executed = true;
    this.state.activeIncidentId = incident.incidentId;
    this.state.modeDeadlineTs = incident.deadlineTs;

    if (incident.level === "HALT") {
      this.state.mode = "HALTED";
      this.state.consecutiveHalts += 1;
    } else {
      this.state.mode = "RESTRICTED";
    }
    return incident;
  }

  clearResponse(): void {
    this.state.mode = "NORMAL";
    this.state.modeDeadlineTs = 0;
    this.state.activeIncidentId = "";
    this.state.consecutiveHalts = 0;
  }

  /** Shorten the active response so the demo can show recovery in seconds. */
  fastForwardToRecovery(): void {
    this.state.modeDeadlineTs = nowTs();
    this.settle();
  }

  /**
   * A simulated validator set.
   *
   * `fromChain` is false, and every caller is expected to label it. This is
   * scripted UI state, not consensus.
   */
  consensus(phase: "evaluating" | "done"): ConsensusOutcome {
    const validators: ValidatorStatus[] = Array.from({ length: 5 }, (_, index) => ({
      index,
      address: `0x${index.toString(16).padStart(40, "0")}`,
      phase: phase === "done" ? "agreed" : "evaluating",
      executionResult: phase === "done" ? "SUCCESS" : null,
    }));
    return {
      validators,
      agreeCount: phase === "done" ? 5 : 0,
      totalCount: 5,
      finalized: phase === "done",
      fromChain: false,
    };
  }
}
