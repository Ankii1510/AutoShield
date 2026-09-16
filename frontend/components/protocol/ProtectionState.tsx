import { MODE_MEANING, formatDuration } from "@/lib/formatters";
import { Panel, StatusPill, type Tone } from "@/components/ui/primitives";
import type { ProtocolMode, ProtocolStatus } from "@/lib/types";

const MODES: readonly ProtocolMode[] = ["NORMAL", "RESTRICTED", "HALTED"];

const TONE: Record<ProtocolMode, Tone> = {
  NORMAL: "ok",
  RESTRICTED: "warn",
  HALTED: "crit",
};

const LABEL: Record<ProtocolMode, string> = {
  NORMAL: "NORMAL",
  RESTRICTED: "PROTECT / RESTRICTED",
  HALTED: "HALT",
};

/**
 * Current protection state, with the live countdown.
 *
 * The countdown is the single most important thing on this screen: it is the
 * anti-brick guarantee made visible. Every response expires on its own, with
 * no transaction from anyone, and HALT steps down through RESTRICTED rather
 * than vanishing straight to NORMAL.
 */
export function ProtectionState({
  status,
  now,
}: {
  status: ProtocolStatus | null;
  now: number;
}) {
  const mode = status?.mode ?? "NORMAL";

  // Derived, never mirrored into state: the countdown is computed from the
  // deadline the chain reported and the shared ticking clock, so it stays
  // anchored to chain time instead of drifting on its own copy.
  const remaining =
    !status || mode === "NORMAL" || status.modeDeadlineTs <= 0
      ? 0
      : Math.max(0, status.modeDeadlineTs - now);

  return (
    <Panel title="Current protection state">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusPill tone={TONE[mode]} glyph={mode === "NORMAL" ? "●" : mode === "RESTRICTED" ? "◐" : "■"} size="lg">
          {LABEL[mode]}
        </StatusPill>

        {mode !== "NORMAL" && (
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
              Expires in
            </p>
            <p
              className="font-mono text-xl tabular text-[var(--color-ink)]"
              aria-live="polite"
            >
              {formatDuration(remaining)}
            </p>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-[var(--color-ink-dim)]">
        {MODE_MEANING[mode]}
      </p>

      <ol className="mt-4 flex items-center gap-1 border-t border-[var(--color-line)] pt-4">
        {MODES.map((step, index) => {
          const active = step === mode;
          return (
            <li key={step} className="flex flex-1 items-center gap-1">
              <div
                className={`flex-1 rounded border px-2 py-1.5 text-center text-[10px] font-mono uppercase tracking-wider ${
                  active
                    ? step === "NORMAL"
                      ? "border-[var(--color-ok)]/50 bg-[var(--color-ok)]/12 text-[var(--color-ok)]"
                      : step === "RESTRICTED"
                        ? "border-[var(--color-warn)]/50 bg-[var(--color-warn)]/12 text-[var(--color-warn)]"
                        : "border-[var(--color-crit)]/50 bg-[var(--color-crit)]/12 text-[var(--color-crit)]"
                    : "border-[var(--color-line)] text-[var(--color-ink-faint)]"
                }`}
                aria-current={active ? "step" : undefined}
              >
                {step}
                {active && <span className="sr-only"> (current state)</span>}
              </div>
              {index < MODES.length - 1 && (
                <span aria-hidden="true" className="text-[var(--color-ink-faint)]">
                  ←
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
        Recovery runs right to left and needs no transaction: HALT decays to RESTRICTED,
        then RESTRICTED to NORMAL. A false positive costs bounded time, never funds.
      </p>
    </Panel>
  );
}
