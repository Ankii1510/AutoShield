/**
 * Frontend data model for AutoShield.
 *
 * These types mirror what the contracts actually return. They are the only
 * shapes the UI is allowed to reason about — raw chain values are normalised
 * into them in `lib/contracts`, so no component ever handles an untyped blob.
 *
 * The authority rule that governs this whole file: a response level is NEVER
 * computed in the browser. `ResponseLevel` values only ever arrive from the
 * chain, either as `Incident.level` (written by the contract's `derive_level`)
 * or from the contract's own `preview_level` view.
 */

/** The three response levels. Decided on-chain by `derive_level()`. */
export type ResponseLevel = "SAFE" | "PROTECT" | "HALT";

/** Operating mode of the protected protocol. */
export type ProtocolMode = "NORMAL" | "RESTRICTED" | "HALTED";

/** Incident lifecycle status, as stored by AutoShield. */
export type IncidentStatus =
  | "READY"
  | "EVALUATED"
  | "APPLIED"
  | "DISMISSED"
  | "STALE";

/** Evidence categories accepted by `report_incident`. */
export type IncidentCategory =
  | "ORACLE_DEVIATION"
  | "BORROW_ANOMALY"
  | "LIQUIDITY_DRAIN"
  | "TX_PATTERN";

/** The closed set of signal flags the evaluation may return. Order matters:
 *  it is the bit order of `signals_bits`. */
export const SIGNAL_NAMES = [
  "price_manipulation",
  "liquidity_drain",
  "borrow_anomaly",
  "coordinated_activity",
  "evidence_inconsistent",
  "condition_resolved",
] as const;

export type SignalName = (typeof SIGNAL_NAMES)[number];

export type SignalFlags = Record<SignalName, boolean>;

/** Signals that can corroborate a HALT. Mirrors DECISIVE_SIGNALS_MASK. */
export const DECISIVE_SIGNALS: readonly SignalName[] = [
  "price_manipulation",
  "liquidity_drain",
  "borrow_anomaly",
  "coordinated_activity",
];

export const SIGNAL_LABELS: Record<SignalName, string> = {
  price_manipulation: "Price manipulation",
  liquidity_drain: "Liquidity drain",
  borrow_anomaly: "Borrow anomaly",
  coordinated_activity: "Coordinated activity",
  evidence_inconsistent: "Evidence inconsistency",
  condition_resolved: "Condition resolved",
};

/** Live telemetry published by DemoLendingProtocol. All integers. */
export interface ProtocolTelemetry {
  priceAtto: bigint;
  baselineAtto: bigint;
  deviationBps: number;
  secondsSinceUpdate: number;
  totalDepositsAtto: bigint;
  totalBorrowedAtto: bigint;
  availableLiquidityAtto: bigint;
  utilisationBps: number;
  windowVolumeBps: number;
  liquidityDeltaBps: number;
  txCount: number;
  uniqueSenders: number;
  topSenderShareBps: number;
  mode: ProtocolMode;
  nowTs: number;
}

/** Operational status of the protected protocol. */
export interface ProtocolStatus {
  mode: ProtocolMode;
  storedMode: ProtocolMode;
  modeDeadlineTs: number;
  secondsRemaining: number;
  activeIncidentId: string;
  consecutiveHalts: number;
  guardAddress: string;
  owner: string;
  nowTs: number;
  borrowEnabled: boolean;
  supplyEnabled: boolean;
  withdrawEnabled: boolean;
  repayEnabled: boolean;
}

/** Evidence as recorded on-chain: a reference and compact metadata, never a blob. */
export interface Evidence {
  category: IncidentCategory | string;
  evidenceHash: string;
  evidenceUri: string;
  metadataJson: string;
  observedAtTs: number;
}

/** The structured result of the GenLayer evaluation, as stored on-chain. */
export interface Evaluation {
  severity: number;
  signalsBits: number;
  signals: SignalFlags;
  evaluatedAtTs: number;
}

/** A registered incident, exactly as AutoShield stores it. */
export interface Incident {
  incidentId: string;
  protocol: string;
  reporter: string;
  status: IncidentStatus;
  evidence: Evidence;
  createdAtTs: number;
  /** Present once adjudicated. */
  evaluation: Evaluation | null;
  /** "" until adjudicated. Written by the contract's derive_level(). */
  level: ResponseLevel | "";
  deadlineTs: number;
  executed: boolean;
}

/** AutoShield's on-chain configuration and policy thresholds. */
export interface ShieldConfig {
  owner: string;
  evaluator: string;
  protocolAddress: string;
  paused: boolean;
  protectSeverityThreshold: number;
  haltSeverityThreshold: number;
  signalNames: readonly string[];
  allSignalsMask: number;
  decisiveSignalsMask: number;
  freshnessWindowSeconds: number;
  evaluationWindowSeconds: number;
  executionWindowSeconds: number;
  protectTtlSeconds: number;
  haltTtlSeconds: number;
  reportCooldownSeconds: number;
  maxOpenIncidents: number;
  maxReportsPerWindow: number;
  openIncidentCount: number;
  incidentCount: number;
}

/** Per-validator outcome for one transaction, read from the receipt. */
export type ValidatorPhase =
  | "idle"
  | "pending"
  | "evaluating"
  | "agreed"
  | "disagreed"
  | "failed";

export interface ValidatorStatus {
  index: number;
  address: string;
  phase: ValidatorPhase;
  executionResult: string | null;
}

/** Consensus outcome of one adjudication transaction. */
export interface ConsensusOutcome {
  validators: ValidatorStatus[];
  agreeCount: number;
  totalCount: number;
  finalized: boolean;
  /** True only when the votes came from a real node receipt. */
  fromChain: boolean;
}

/** Lifecycle of a single write transaction. Never jump to `confirmed` on submit. */
export type TransactionPhase =
  | "idle"
  | "awaiting-wallet"
  | "submitted"
  | "pending"
  | "confirmed"
  | "failed";

export interface TransactionState {
  id: string;
  label: string;
  phase: TransactionPhase;
  hash: string | null;
  /** Lifecycle status reported by the node (ACCEPTED / FINALIZED / ...). */
  statusName: string | null;
  /** Contract execution result. SUCCESS/ERROR — not the same as the status. */
  executionResult: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  /** True when this entry describes a simulated action, not a chain transaction. */
  simulated: boolean;
}

export type TimelineKind =
  | "detection"
  | "incident"
  | "evidence"
  | "adjudication"
  | "consensus"
  | "decision"
  | "response"
  | "recovery";

export interface IncidentTimelineEvent {
  id: string;
  kind: TimelineKind;
  label: string;
  detail?: string;
  /** Unix seconds. Chain time where available. */
  ts: number;
  txHash?: string | null;
  simulated: boolean;
}

/** Which backend the console is talking to. Surfaced in the UI, never hidden. */
export type ConsoleMode = "chain" | "demo";

/**
 * What the connected wallet is actually permitted to do, read from the
 * contract rather than assumed.
 *
 * AutoShield is a guarded operator system, not an open dapp: reporting is
 * allowlisted and adjudication is restricted to a single evaluator address, by
 * design (unauthenticated reporting would be a free denial-of-service surface
 * against the protected protocol). Two actions are deliberately permissionless
 * — executing an already-adjudicated response, and expiring a stale incident —
 * because both only ever move the system toward safety or toward recovery, and
 * neither must depend on one key being online.
 *
 * The console shows this honestly: a visitor sees which actions their own
 * wallet can take, instead of buttons that fail on submission.
 */
export interface OperatorRoles {
  address: string;
  isOwner: boolean;
  isEvaluator: boolean;
  isReporter: boolean;
}

export interface ConnectionState {
  mode: ConsoleMode;
  connected: boolean;
  address: string | null;
  chainId: number | null;
  rpcUrl: string;
  error: string | null;
  /**
   * A non-fatal condition the operator must see, above all a chain-id
   * mismatch between the configured network and what the node actually
   * reports. Kept separate from `error` so a wrong-network console still
   * shows its data, clearly marked, instead of silently reading the wrong
   * chain.
   */
  warning: string | null;
}
