import { shortenAddress } from "@/lib/formatters";
import {
  EmptyState,
  Panel,
  SimulatedBadge,
  StatusPill,
  type Tone,
} from "@/components/ui/primitives";
import type { ConsensusOutcome, ValidatorPhase } from "@/lib/types";

const PHASE_LABEL: Record<ValidatorPhase, string> = {
  idle: "Idle",
  pending: "Pending",
  evaluating: "Evaluating",
  agreed: "Evaluated · agreed",
  disagreed: "Disagreed",
  failed: "Execution failed",
};

const PHASE_TONE: Record<ValidatorPhase, Tone> = {
  idle: "neutral",
  pending: "neutral",
  evaluating: "info",
  agreed: "ok",
  disagreed: "warn",
  failed: "crit",
};

const PHASE_GLYPH: Record<ValidatorPhase, string> = {
  idle: "○",
  pending: "○",
  evaluating: "◍",
  agreed: "✓",
  disagreed: "✕",
  failed: "!",
};

/**
 * Validator panel.
 *
 * Honesty rule: when `fromChain` is false these rows describe a scripted demo,
 * not consensus, and the panel says so prominently. The console never dresses
 * simulated agreement up as validator agreement.
 */
export function ValidatorPanel({
  consensus,
  evaluating,
}: {
  consensus: ConsensusOutcome | null;
  evaluating: boolean;
}) {
  const validators =
    consensus?.validators ??
    (evaluating
      ? Array.from({ length: 5 }, (_, index) => ({
          index,
          address: "",
          phase: "evaluating" as ValidatorPhase,
          executionResult: null,
        }))
      : []);

  const simulated = consensus ? !consensus.fromChain : false;

  return (
    <Panel
      title="Validator set"
      subtitle={
        consensus
          ? `${consensus.agreeCount} of ${consensus.totalCount} agreed${consensus.finalized ? " · finalized" : ""}`
          : "No adjudication in this session yet"
      }
      actions={
        consensus ? (
          simulated ? (
            <SimulatedBadge reason="Demo mode: these validator rows are scripted UI state, not consensus." />
          ) : (
            <StatusPill tone="ok" glyph="⛓">
              From chain
            </StatusPill>
          )
        ) : null
      }
    >
      {validators.length === 0 ? (
        <EmptyState>
          Run an adjudication to see validator activity.
        </EmptyState>
      ) : (
        <ul className="space-y-1.5">
          {validators.map((validator) => (
            <li
              key={validator.index}
              className="flex items-center justify-between gap-3 rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2"
            >
              <span className="flex items-center gap-2 text-xs">
                <span className="font-mono text-[var(--color-ink-faint)]">
                  Validator {validator.index + 1}
                </span>
                {validator.address && (
                  <span className="hidden font-mono text-[10px] text-[var(--color-ink-faint)] sm:inline">
                    {shortenAddress(validator.address, 4)}
                  </span>
                )}
              </span>
              <span
                className={`flex items-center gap-1.5 font-mono text-[11px] ${
                  PHASE_TONE[validator.phase] === "ok"
                    ? "text-[var(--color-ok)]"
                    : PHASE_TONE[validator.phase] === "warn"
                      ? "text-[var(--color-warn)]"
                      : PHASE_TONE[validator.phase] === "crit"
                        ? "text-[var(--color-crit)]"
                        : PHASE_TONE[validator.phase] === "info"
                          ? "text-[var(--color-info)]"
                          : "text-[var(--color-ink-faint)]"
                } ${validator.phase === "evaluating" ? "soc-pulse" : ""}`}
              >
                <span aria-hidden="true">{PHASE_GLYPH[validator.phase]}</span>
                {PHASE_LABEL[validator.phase]}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 border-t border-[var(--color-line)] pt-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
        {simulated
          ? "Demo mode does not run consensus. On a GenLayer node each validator independently re-runs the contract's own validator function and votes; a majority is required and the leader rotates on disagreement."
          : "Each validator independently re-runs the contract's validator function against the leader's result. Agreement requires identical signal flags, severities within ±15, and the same derived response level."}
      </p>
    </Panel>
  );
}
