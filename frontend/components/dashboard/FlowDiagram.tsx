import type { FlowStage } from "@/lib/state/useAutoShield";

/**
 * The decision pipeline, always on screen.
 *
 * This is the 30-second explanation of AutoShield: evidence goes in, GenLayer
 * scores it, validators agree, and a deterministic rule — not the model — turns
 * that score into a bounded response.
 */
const STEPS: Array<{ id: string; label: string; stages: FlowStage[] }> = [
  { id: "evidence", label: "Evidence", stages: ["simulating", "reporting"] },
  { id: "genlayer", label: "GenLayer evaluation", stages: ["adjudicating"] },
  { id: "validators", label: "Validator evaluation", stages: ["adjudicating"] },
  { id: "consensus", label: "Consensus", stages: ["adjudicating"] },
  { id: "verdict", label: "Severity + signals", stages: ["deciding"] },
  { id: "policy", label: "derive_level()", stages: ["deciding"] },
  { id: "response", label: "Response", stages: ["responding"] },
  { id: "state", label: "Protocol state", stages: ["active", "recovered"] },
];

const ORDER: FlowStage[] = [
  "idle",
  "simulating",
  "reporting",
  "adjudicating",
  "deciding",
  "responding",
  "active",
  "recovered",
];

export function FlowDiagram({ stage }: { stage: FlowStage }) {
  const currentIndex = ORDER.indexOf(stage);

  return (
    <nav
      aria-label="Adjudication pipeline"
      className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5"
    >
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
        {STEPS.map((step, index) => {
          const active = step.stages.includes(stage);
          const stepIndex = Math.min(...step.stages.map((s) => ORDER.indexOf(s)));
          const done = currentIndex > stepIndex && !active;

          const isPolicy = step.id === "policy";

          return (
            <li key={step.id} className="flex items-center gap-1">
              <span
                aria-current={active ? "step" : undefined}
                className={`relative overflow-hidden rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                  active
                    ? "bg-[var(--color-info)]/15 text-[var(--color-info)] soc-sweep"
                    : done
                      ? "text-[var(--color-ok)]"
                      : isPolicy
                        ? "text-[var(--color-ink-dim)]"
                        : "text-[var(--color-ink-faint)]"
                } ${isPolicy ? "border border-[var(--color-line-bright)]" : ""}`}
                title={
                  isPolicy
                    ? "Deterministic on-chain policy. The only thing that decides SAFE, PROTECT or HALT."
                    : undefined
                }
              >
                {done && <span aria-hidden="true">✓ </span>}
                {step.label}
              </span>
              {index < STEPS.length - 1 && (
                <span aria-hidden="true" className="text-[var(--color-ink-faint)]">
                  →
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
