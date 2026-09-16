import { formatBps } from "@/lib/formatters";
import { Gauge, Panel, type Tone } from "@/components/ui/primitives";
import type { Incident, ProtocolTelemetry } from "@/lib/types";

/**
 * Live threat monitor.
 *
 * Thresholds mirror the ones the contract hands the evaluator as ground truth,
 * so the operator sees the same reference points the adjudication reasons
 * about. Crossing a threshold is a *signal*, never a decision.
 */
const THRESHOLDS = {
  deviation: 1500,
  liquidity: 3000,
  borrow: 5000,
  concentration: 8000,
} as const;

interface Row {
  key: string;
  label: string;
  reading: string;
  valueBps: number;
  thresholdBps?: number;
  tone: Tone;
  state: string;
  glyph: string;
}

function toneFor(value: number, threshold: number): { tone: Tone; state: string; glyph: string } {
  if (value >= threshold) return { tone: "crit", state: "Exceeded", glyph: "▲" };
  if (value >= threshold * 0.6) return { tone: "warn", state: "Elevated", glyph: "▲" };
  return { tone: "ok", state: "Nominal", glyph: "●" };
}

export function ThreatMonitor({
  telemetry,
  incident,
}: {
  telemetry: ProtocolTelemetry | null;
  incident: Incident | null;
}) {
  const t = telemetry;

  const deviation = toneFor(t?.deviationBps ?? 0, THRESHOLDS.deviation);
  const liquidity = toneFor(t?.liquidityDeltaBps ?? 0, THRESHOLDS.liquidity);
  const borrow = toneFor(t?.windowVolumeBps ?? 0, THRESHOLDS.borrow);
  const concentration = toneFor(t?.topSenderShareBps ?? 0, THRESHOLDS.concentration);

  // Evidence consistency is not a telemetry reading — it is a signal the
  // evaluation raises. Shown here only once an evaluation exists.
  const inconsistent = incident?.evaluation?.signals.evidence_inconsistent ?? false;
  const hasEvaluation = Boolean(incident?.evaluation);

  const rows: Row[] = [
    {
      key: "oracle",
      label: "Oracle / price movement",
      reading: t ? formatBps(t.deviationBps) : "—",
      valueBps: t?.deviationBps ?? 0,
      thresholdBps: THRESHOLDS.deviation,
      ...deviation,
    },
    {
      key: "liquidity",
      label: "Liquidity movement",
      reading: t && t.liquidityDeltaBps > 0 ? `-${formatBps(t.liquidityDeltaBps)}` : "Normal",
      valueBps: t?.liquidityDeltaBps ?? 0,
      thresholdBps: THRESHOLDS.liquidity,
      ...liquidity,
    },
    {
      key: "borrow",
      label: "Borrowing anomaly",
      reading: t && t.windowVolumeBps > 0 ? formatBps(t.windowVolumeBps) : "Normal",
      valueBps: t?.windowVolumeBps ?? 0,
      thresholdBps: THRESHOLDS.borrow,
      ...borrow,
    },
    {
      key: "coordinated",
      label: "Coordinated activity",
      reading:
        t && t.txCount > 0
          ? `${t.txCount} tx · ${t.uniqueSenders} senders · ${formatBps(t.topSenderShareBps, 0)} top`
          : "Normal",
      valueBps: t?.topSenderShareBps ?? 0,
      thresholdBps: THRESHOLDS.concentration,
      ...concentration,
    },
    {
      key: "consistency",
      label: "Evidence consistency",
      reading: !hasEvaluation
        ? "Awaiting evaluation"
        : inconsistent
          ? "Contradicts telemetry"
          : "Consistent",
      valueBps: 0,
      tone: !hasEvaluation ? "neutral" : inconsistent ? "crit" : "ok",
      state: !hasEvaluation ? "Pending" : inconsistent ? "Inconsistent" : "Consistent",
      glyph: !hasEvaluation ? "○" : inconsistent ? "▲" : "●",
    },
  ];

  return (
    <Panel title="Live threat monitor" subtitle="Read from the protocol's own telemetry">
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex items-center gap-2 text-xs text-[var(--color-ink-dim)]">
                <span
                  aria-hidden="true"
                  className={
                    row.tone === "crit"
                      ? "text-[var(--color-crit)]"
                      : row.tone === "warn"
                        ? "text-[var(--color-warn)]"
                        : row.tone === "ok"
                          ? "text-[var(--color-ok)]"
                          : "text-[var(--color-ink-faint)]"
                  }
                >
                  {row.glyph}
                </span>
                {row.label}
              </span>
              <span className="shrink-0 font-mono text-xs tabular text-[var(--color-ink)]">
                {row.reading}
                <span className="sr-only"> — {row.state}</span>
              </span>
            </div>
            {row.thresholdBps !== undefined && (
              <div className="mt-1.5">
                <Gauge
                  valueBps={row.valueBps}
                  thresholdBps={row.thresholdBps}
                  tone={row.tone}
                  label={`${row.label}: ${row.reading}, ${row.state}`}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-[var(--color-line)] pt-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
        Thresholds shown are the same reference points the contract passes to the
        evaluator as ground truth. A crossed threshold is evidence, not a decision —
        one elevated metric never justifies a halt on its own.
      </p>
    </Panel>
  );
}
