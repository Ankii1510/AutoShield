/**
 * Demo scenarios for the attack simulator.
 *
 * SAFETY. None of this is an exploit. Each scenario is a list of owner-only
 * calls on the *demo* protocol that move its own reported telemetry into an
 * anomalous-looking state — `simulate_oracle_move`, `simulate_borrow_spike`,
 * `simulate_liquidity_drain`, `simulate_tx_burst`. They touch no external
 * contract, implement no attack mechanic, and (apart from the oracle price,
 * which is a legitimate protocol parameter) never mutate real accounting: the
 * protocol's own `conservation_check()` holds before and after every one.
 *
 * `expected` describes what the operator should see change. It is a preview for
 * the UI, never a substitute for reading the protocol afterwards.
 */

import type { IncidentCategory, SignalName } from "@/lib/types";

export type SimulationStep =
  | { kind: "oracle"; magnitudeBps: number; direction: "UP" | "DOWN" }
  | { kind: "borrow"; windowVolumeBps: number }
  | { kind: "liquidity"; drainBps: number }
  | { kind: "tx"; txCount: number; uniqueSenders: number; topSenderShareBps: number }
  | { kind: "reset" };

export interface ExpectedMetric {
  label: string;
  before: string;
  after: string;
  /** Direction of concern, for the arrow and the screen-reader text. */
  trend: "up" | "down" | "flat";
}

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  category: IncidentCategory;
  /** Severity band the operator should expect. Never used to decide anything. */
  outlook: "benign" | "suspicious" | "critical";
  steps: SimulationStep[];
  expected: ExpectedMetric[];
  /** Metadata the reporter will claim. Compact, integer basis points only. */
  claimed: Record<string, number>;
  /** Signals a competent evaluator would be expected to raise. Illustrative. */
  likelySignals: SignalName[];
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "normal",
    name: "Normal activity",
    blurb:
      "Baseline market movement. Nothing here should justify restricting the protocol.",
    category: "ORACLE_DEVIATION",
    outlook: "benign",
    steps: [{ kind: "reset" }, { kind: "oracle", magnitudeBps: 180, direction: "DOWN" }],
    expected: [
      { label: "Oracle deviation", before: "0.00%", after: "1.80%", trend: "up" },
      { label: "Liquidity", before: "Normal", after: "Normal", trend: "flat" },
      { label: "Borrowing", before: "Normal", after: "Normal", trend: "flat" },
    ],
    claimed: { deviation_bps: 180 },
    likelySignals: [],
  },
  {
    id: "oracle",
    name: "Oracle anomaly",
    blurb:
      "A large, abrupt price move against the baseline. On its own this is ambiguous — markets crash too.",
    category: "ORACLE_DEVIATION",
    outlook: "suspicious",
    steps: [{ kind: "reset" }, { kind: "oracle", magnitudeBps: 3800, direction: "DOWN" }],
    expected: [
      { label: "Oracle deviation", before: "0.00%", after: "38.00%", trend: "up" },
      { label: "Liquidity", before: "Normal", after: "Normal", trend: "flat" },
      { label: "Borrowing", before: "Normal", after: "Normal", trend: "flat" },
    ],
    claimed: { deviation_bps: 3800 },
    likelySignals: ["price_manipulation"],
  },
  {
    id: "liquidity",
    name: "Liquidity drain",
    blurb: "Liquidity leaving far faster than normal operation explains.",
    category: "LIQUIDITY_DRAIN",
    outlook: "suspicious",
    steps: [{ kind: "reset" }, { kind: "liquidity", drainBps: 4500 }],
    expected: [
      { label: "Oracle deviation", before: "0.00%", after: "0.00%", trend: "flat" },
      { label: "Liquidity", before: "Normal", after: "-45.00%", trend: "down" },
      { label: "Borrowing", before: "Normal", after: "Normal", trend: "flat" },
    ],
    claimed: { liquidity_delta_bps: 4500 },
    likelySignals: ["liquidity_drain"],
  },
  {
    id: "borrow",
    name: "Borrow anomaly",
    blurb: "Borrowing volume inconsistent with normal demand for this pool.",
    category: "BORROW_ANOMALY",
    outlook: "suspicious",
    steps: [{ kind: "reset" }, { kind: "borrow", windowVolumeBps: 6200 }],
    expected: [
      { label: "Oracle deviation", before: "0.00%", after: "0.00%", trend: "flat" },
      { label: "Liquidity", before: "Normal", after: "Normal", trend: "flat" },
      { label: "Borrow window volume", before: "0.00%", after: "62.00%", trend: "up" },
    ],
    claimed: { window_volume_bps: 6200 },
    likelySignals: ["borrow_anomaly"],
  },
  {
    id: "coordinated",
    name: "Coordinated suspicious activity",
    blurb:
      "A burst of transactions concentrated in very few senders, alongside elevated borrowing.",
    category: "TX_PATTERN",
    outlook: "suspicious",
    steps: [
      { kind: "reset" },
      { kind: "tx", txCount: 320, uniqueSenders: 3, topSenderShareBps: 8800 },
      { kind: "borrow", windowVolumeBps: 5400 },
    ],
    expected: [
      { label: "Transactions / window", before: "0", after: "320", trend: "up" },
      { label: "Unique senders", before: "0", after: "3", trend: "down" },
      { label: "Top sender share", before: "0.00%", after: "88.00%", trend: "up" },
    ],
    claimed: { top_sender_share_bps: 8800, window_volume_bps: 5400 },
    likelySignals: ["coordinated_activity", "borrow_anomaly"],
  },
  {
    id: "critical",
    name: "Critical exploit scenario",
    blurb:
      "Every independent signal moves at once: price, liquidity, borrowing and sender concentration. This is the shape corroboration is meant to detect.",
    category: "ORACLE_DEVIATION",
    outlook: "critical",
    steps: [
      { kind: "reset" },
      { kind: "oracle", magnitudeBps: 4100, direction: "DOWN" },
      { kind: "liquidity", drainBps: 5200 },
      { kind: "borrow", windowVolumeBps: 7400 },
      { kind: "tx", txCount: 480, uniqueSenders: 2, topSenderShareBps: 9400 },
    ],
    expected: [
      { label: "Oracle deviation", before: "0.00%", after: "41.00%", trend: "up" },
      { label: "Liquidity", before: "Normal", after: "-52.00%", trend: "down" },
      { label: "Borrow window volume", before: "0.00%", after: "74.00%", trend: "up" },
      { label: "Top sender share", before: "0.00%", after: "94.00%", trend: "up" },
    ],
    claimed: {
      deviation_bps: 4100,
      liquidity_delta_bps: 5200,
      window_volume_bps: 7400,
      top_sender_share_bps: 9400,
    },
    likelySignals: [
      "price_manipulation",
      "liquidity_drain",
      "borrow_anomaly",
      "coordinated_activity",
    ],
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Deterministic pseudo-hash for demo evidence. Not a security primitive. */
export function demoEvidenceHash(scenarioId: string, nonce: number): string {
  let h = 0x811c9dc5;
  const input = `${scenarioId}:${nonce}`;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const seed = h.toString(16).padStart(8, "0");
  return `0x${seed.repeat(8)}`;
}
