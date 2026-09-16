/**
 * Normalisation of raw contract return values into the typed model.
 *
 * Contract views return plain dicts over calldata, so everything arriving here
 * is `unknown`. These helpers are deliberately defensive: a missing or
 * malformed field degrades to a safe default rather than throwing, because a
 * security console that blanks out on one unexpected value is worse than one
 * that shows a conservative reading.
 *
 * The one thing that is NEVER defaulted is a response level. An unrecognised
 * level becomes `""` (not adjudicated) — never SAFE, and never HALT.
 */

import {
  SIGNAL_NAMES,
  type Evaluation,
  type Evidence,
  type Incident,
  type IncidentStatus,
  type ProtocolMode,
  type ProtocolStatus,
  type ProtocolTelemetry,
  type ResponseLevel,
  type ShieldConfig,
  type SignalFlags,
  type SignalName,
} from "@/lib/types";

type Raw = Record<string, unknown>;

export function asRecord(value: unknown): Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : {};
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function big(value: unknown, fallback = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return fallback;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return fallback;
}

const MODES: readonly ProtocolMode[] = ["NORMAL", "RESTRICTED", "HALTED"];

export function toMode(value: unknown): ProtocolMode {
  const text = str(value);
  return (MODES as readonly string[]).includes(text)
    ? (text as ProtocolMode)
    : "NORMAL";
}

const LEVELS: readonly ResponseLevel[] = ["SAFE", "PROTECT", "HALT"];

/**
 * A level is only ever accepted if the chain returned one of the three known
 * values. Anything else is treated as "not adjudicated yet".
 */
export function toLevel(value: unknown): ResponseLevel | "" {
  const text = str(value);
  return (LEVELS as readonly string[]).includes(text)
    ? (text as ResponseLevel)
    : "";
}

const STATUSES: readonly IncidentStatus[] = [
  "READY",
  "EVALUATED",
  "APPLIED",
  "DISMISSED",
  "STALE",
];

export function toStatus(value: unknown): IncidentStatus {
  const text = str(value);
  return (STATUSES as readonly string[]).includes(text)
    ? (text as IncidentStatus)
    : "READY";
}

export function decodeSignals(bits: number): SignalFlags {
  const flags = {} as SignalFlags;
  SIGNAL_NAMES.forEach((name: SignalName, index: number) => {
    flags[name] = ((bits >> index) & 1) === 1;
  });
  return flags;
}

export function encodeSignals(flags: Partial<SignalFlags>): number {
  let bits = 0;
  SIGNAL_NAMES.forEach((name, index) => {
    if (flags[name]) bits |= 1 << index;
  });
  return bits;
}

export function decodeTelemetry(raw: unknown): ProtocolTelemetry {
  const r = asRecord(raw);
  return {
    priceAtto: big(r.price_atto),
    baselineAtto: big(r.baseline_atto),
    deviationBps: num(r.deviation_bps),
    secondsSinceUpdate: num(r.seconds_since_update),
    totalDepositsAtto: big(r.total_deposits_atto),
    totalBorrowedAtto: big(r.total_borrowed_atto),
    availableLiquidityAtto: big(r.available_liquidity_atto),
    utilisationBps: num(r.utilisation_bps),
    windowVolumeBps: num(r.window_volume_bps),
    liquidityDeltaBps: num(r.liquidity_delta_bps),
    txCount: num(r.tx_count),
    uniqueSenders: num(r.unique_senders),
    topSenderShareBps: num(r.top_sender_share_bps),
    mode: toMode(r.mode),
    nowTs: num(r.now_ts),
  };
}

export function decodeStatus(raw: unknown): ProtocolStatus {
  const r = asRecord(raw);
  return {
    mode: toMode(r.mode),
    storedMode: toMode(r.stored_mode),
    modeDeadlineTs: num(r.mode_deadline_ts),
    secondsRemaining: num(r.seconds_remaining),
    activeIncidentId: str(r.active_incident_id),
    consecutiveHalts: num(r.consecutive_halts),
    guardAddress: str(r.guard_address),
    owner: str(r.owner),
    nowTs: num(r.now_ts),
    borrowEnabled: bool(r.borrow_enabled),
    supplyEnabled: bool(r.supply_enabled),
    withdrawEnabled: bool(r.withdraw_enabled),
    repayEnabled: bool(r.repay_enabled, true),
  };
}

export function decodeIncident(raw: unknown): Incident {
  const r = asRecord(raw);
  const severity = num(r.severity);
  const signalsBits = num(r.signals_bits);
  const evaluatedAtTs = num(r.evaluated_at_ts);
  const level = toLevel(r.level);

  const evidence: Evidence = {
    category: str(r.category),
    evidenceHash: str(r.evidence_hash),
    evidenceUri: str(r.evidence_uri),
    metadataJson: str(r.metadata_json),
    observedAtTs: num(r.observed_at_ts),
  };

  // An evaluation exists only once the contract has actually adjudicated;
  // `evaluated_at_ts` is zero until then.
  const evaluation: Evaluation | null =
    evaluatedAtTs > 0
      ? {
          severity,
          signalsBits,
          signals: decodeSignals(signalsBits),
          evaluatedAtTs,
        }
      : null;

  return {
    incidentId: str(r.incident_id),
    protocol: str(r.protocol),
    reporter: str(r.reporter),
    status: toStatus(r.status),
    evidence,
    createdAtTs: num(r.created_at_ts),
    evaluation,
    level,
    deadlineTs: num(r.deadline_ts),
    executed: bool(r.executed),
  };
}

export function decodeConfig(raw: unknown): ShieldConfig {
  const r = asRecord(raw);
  const names = Array.isArray(r.signal_names)
    ? r.signal_names.filter((n): n is string => typeof n === "string")
    : [...SIGNAL_NAMES];

  return {
    owner: str(r.owner),
    evaluator: str(r.evaluator),
    protocolAddress: str(r.protocol_address),
    paused: bool(r.paused),
    protectSeverityThreshold: num(r.protect_severity_threshold, 40),
    haltSeverityThreshold: num(r.halt_severity_threshold, 75),
    signalNames: names,
    allSignalsMask: num(r.all_signals_mask, 63),
    decisiveSignalsMask: num(r.decisive_signals_mask, 15),
    freshnessWindowSeconds: num(r.freshness_window_seconds, 600),
    evaluationWindowSeconds: num(r.evaluation_window_seconds, 900),
    executionWindowSeconds: num(r.execution_window_seconds, 300),
    protectTtlSeconds: num(r.protect_ttl_seconds, 3600),
    haltTtlSeconds: num(r.halt_ttl_seconds, 1800),
    reportCooldownSeconds: num(r.report_cooldown_seconds, 60),
    maxOpenIncidents: num(r.max_open_incidents, 8),
    maxReportsPerWindow: num(r.max_reports_per_window, 20),
    openIncidentCount: num(r.open_incident_count),
    incidentCount: num(r.incident_count),
  };
}

export function decodeIncidentIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}
