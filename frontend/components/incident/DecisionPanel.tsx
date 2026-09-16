import {
  DECISIVE_SIGNALS,
  SIGNAL_LABELS,
  type Incident,
  type ResponseLevel,
  type ShieldConfig,
  type SignalName,
} from "@/lib/types";
import { LEVEL_MEANING, MODE_FOR_LEVEL } from "@/lib/formatters";
import { EmptyState, Panel, StatusPill, type Tone } from "@/components/ui/primitives";

export const LEVEL_TONE: Record<ResponseLevel, Tone> = {
  SAFE: "ok",
  PROTECT: "warn",
  HALT: "crit",
};

export const LEVEL_GLYPH: Record<ResponseLevel, string> = {
  SAFE: "●",
  PROTECT: "◐",
  HALT: "■",
};

/**
 * "Why this decision?"
 *
 * Shows only the structured evaluation and the deterministic rule that acted on
 * it. No model reasoning, no chain-of-thought, no prose from the evaluator — by
 * design, the evaluation's only outputs are a severity and six booleans.
 *
 * `derivedLevel` is what the CONTRACT's own `preview_level` view returns for
 * this evaluation. It is displayed beside the stored level so an operator can
 * see the rule and the outcome agree.
 */
export function DecisionPanel({
  incident,
  config,
  derivedLevel,
}: {
  incident: Incident | null;
  config: ShieldConfig | null;
  derivedLevel: ResponseLevel | "";
}) {
  const evaluation = incident?.evaluation ?? null;
  const level = incident?.level ?? "";

  if (!evaluation || !level) {
    return (
      <Panel title="Why this decision?">
        <EmptyState>Awaiting adjudication.</EmptyState>
      </Panel>
    );
  }

  const haltThreshold = config?.haltSeverityThreshold ?? 75;
  const protectThreshold = config?.protectSeverityThreshold ?? 40;

  const corroborating = DECISIVE_SIGNALS.filter(
    (name: SignalName) => evaluation.signals[name],
  );
  const inconsistent = evaluation.signals.evidence_inconsistent;
  const resolved = evaluation.signals.condition_resolved;

  const rule = explainRule({
    severity: evaluation.severity,
    corroboratingCount: corroborating.length,
    inconsistent,
    resolved,
    haltThreshold,
    protectThreshold,
    level,
  });

  return (
    <Panel title="Why this decision?">
      <div className="space-y-3 text-xs">
        <Row label="GenLayer evaluation">
          <span className="font-mono tabular text-[var(--color-ink)]">
            Severity {evaluation.severity} / 100
          </span>
        </Row>

        <Row label="Signals">
          <span className="text-right text-[var(--color-ink)]">
            {corroborating.length === 0 ? (
              <span className="font-mono">no corroborating signals</span>
            ) : (
              <span className="font-mono">
                {corroborating.length} corroborating
              </span>
            )}
            {corroborating.length > 0 && (
              <span className="mt-0.5 block text-[11px] text-[var(--color-ink-faint)]">
                {corroborating.map((n) => SIGNAL_LABELS[n]).join(", ")}
              </span>
            )}
            {inconsistent && (
              <span className="mt-0.5 block text-[11px] text-[var(--color-warn)]">
                evidence inconsistency flagged
              </span>
            )}
            {resolved && (
              <span className="mt-0.5 block text-[11px] text-[var(--color-ok)]">
                condition already resolved
              </span>
            )}
          </span>
        </Row>

        <Row label="Deterministic rule">
          <span className="text-right font-mono text-[11px] leading-relaxed text-[var(--color-ink-dim)]">
            {rule}
          </span>
        </Row>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-line)] pt-3">
          <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
            Final
          </span>
          <div className="flex items-center gap-2">
            {derivedLevel && derivedLevel !== level && (
              <span
                className="font-mono text-[10px] text-[var(--color-crit)]"
                title="The contract's policy view disagrees with the stored level. Investigate before acting."
              >
                ⚠ policy view says {derivedLevel}
              </span>
            )}
            <StatusPill tone={LEVEL_TONE[level]} glyph={LEVEL_GLYPH[level]} size="lg">
              {level}
            </StatusPill>
          </div>
        </div>

        <p className="text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          {LEVEL_MEANING[level]} Protocol response: {MODE_FOR_LEVEL[level]}.
        </p>

        <p className="border-t border-[var(--color-line)] pt-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          The evaluation returns a severity score and six boolean flags — nothing
          else. It cannot name a response level. <code>derive_level()</code>, running
          on-chain and identical on every validator, turns those numbers into
          SAFE, PROTECT or HALT.
        </p>
      </div>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
        {label}
      </span>
      {children}
    </div>
  );
}

export function explainRule({
  severity,
  corroboratingCount,
  inconsistent,
  resolved,
  haltThreshold,
  protectThreshold,
  level,
}: {
  severity: number;
  corroboratingCount: number;
  inconsistent: boolean;
  resolved: boolean;
  haltThreshold: number;
  protectThreshold: number;
  level: ResponseLevel;
}): string {
  if (resolved) return "condition_resolved set → SAFE at any severity";
  if (level === "HALT") {
    return `severity ≥ ${haltThreshold} and ${corroboratingCount} corroborating signal${corroboratingCount === 1 ? "" : "s"} → HALT threshold satisfied`;
  }
  if (severity >= haltThreshold && inconsistent) {
    return `severity ≥ ${haltThreshold} but evidence inconsistent → capped at PROTECT`;
  }
  if (severity >= haltThreshold && corroboratingCount === 0) {
    return `severity ≥ ${haltThreshold} but no corroborating signal → capped at PROTECT`;
  }
  if (severity >= protectThreshold) {
    return `severity ≥ ${protectThreshold} → PROTECT`;
  }
  return `severity < ${protectThreshold} → SAFE`;
}
