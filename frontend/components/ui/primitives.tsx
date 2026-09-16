import type { ReactNode } from "react";

/**
 * Console primitives.
 *
 * Accessibility rule applied throughout: colour never carries meaning alone.
 * Every status shows a glyph and a word as well as a hue, so the console is
 * readable in greyscale and to a screen reader.
 */

export type Tone = "ok" | "warn" | "crit" | "info" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-[var(--color-ok)]",
  warn: "text-[var(--color-warn)]",
  crit: "text-[var(--color-crit)]",
  info: "text-[var(--color-info)]",
  neutral: "text-[var(--color-ink-dim)]",
};

const TONE_BORDER: Record<Tone, string> = {
  ok: "border-[var(--color-ok)]/35",
  warn: "border-[var(--color-warn)]/35",
  crit: "border-[var(--color-crit)]/35",
  info: "border-[var(--color-info)]/35",
  neutral: "border-[var(--color-line-bright)]",
};

const TONE_BG: Record<Tone, string> = {
  ok: "bg-[var(--color-ok)]/10",
  warn: "bg-[var(--color-warn)]/10",
  crit: "bg-[var(--color-crit)]/10",
  info: "bg-[var(--color-info)]/10",
  neutral: "bg-[var(--color-surface-2)]",
};

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-panel)] ${className}`}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-line)] px-5 py-3.5">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Status chip: glyph + label + tone. Never tone alone. */
export function StatusPill({
  tone,
  glyph,
  children,
  size = "sm",
}: {
  tone: Tone;
  glyph?: string;
  children: ReactNode;
  size?: "sm" | "lg";
}) {
  const pad = size === "lg" ? "px-3 py-1.5 text-sm" : "px-2 py-0.5 text-[11px]";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border font-mono font-medium uppercase tracking-wider ${pad} ${TONE_TEXT[tone]} ${TONE_BORDER[tone]} ${TONE_BG[tone]}`}
    >
      {glyph && <span aria-hidden="true">{glyph}</span>}
      {children}
    </span>
  );
}

export function Metric({
  label,
  value,
  hint,
  tone = "neutral",
  mono = true,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
        {label}
      </dt>
      <dd
        className={`mt-1 truncate text-lg ${mono ? "font-mono tabular" : ""} ${TONE_TEXT[tone]}`}
      >
        {value}
      </dd>
      {hint && <p className="mt-0.5 text-[11px] text-[var(--color-ink-faint)]">{hint}</p>}
    </div>
  );
}

/** Horizontal gauge with an explicit threshold marker. */
export function Gauge({
  valueBps,
  thresholdBps,
  tone,
  label,
}: {
  valueBps: number;
  thresholdBps?: number;
  tone: Tone;
  label: string;
}) {
  const pct = Math.max(0, Math.min(100, valueBps / 100));
  const markerPct =
    thresholdBps === undefined ? null : Math.max(0, Math.min(100, thresholdBps / 100));

  const fill =
    tone === "crit"
      ? "bg-[var(--color-crit)]"
      : tone === "warn"
        ? "bg-[var(--color-warn)]"
        : tone === "ok"
          ? "bg-[var(--color-ok)]"
          : "bg-[var(--color-info)]";

  return (
    <div
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-line)]"
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      {markerPct !== null && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-[var(--color-ink-faint)]"
          style={{ left: `${markerPct}%` }}
        />
      )}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  title,
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  full?: boolean;
}) {
// A disabled control is GREY, never a faded version of its colour. Fading a
// solid fill turns a decisive blue button into pastel and a red one into pink,
// which is both ugly and misleading: washed-out red still reads as "danger,
// sort of". Unavailable should look unavailable, not half-armed.
const DISABLED =
  "disabled:cursor-not-allowed disabled:border-[var(--color-line)] " +
  "disabled:bg-[var(--color-surface-2)] disabled:text-[var(--color-ink-faint)] " +
  "disabled:shadow-none disabled:brightness-100";

  // The consequential actions are solid, not tinted outlines. A control that
  // halts a protocol should look like it means it, and a row of same-weight
  // outlined buttons gives the operator no hierarchy to read under pressure.
  const styles: Record<string, string> = {
    default:
      "border-[var(--color-line-bright)] bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-panel)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-ink-faint)]",
    primary:
      "border-transparent bg-[var(--color-info)] text-white shadow-[var(--shadow-panel)] hover:brightness-110",
    danger:
      "border-transparent bg-[var(--color-crit)] text-white shadow-[var(--shadow-panel)] hover:brightness-110",
    ghost:
      "border-transparent bg-transparent text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-medium transition-all ${DISABLED} ${styles[variant]} ${full ? "w-full" : ""}`}
    >
      {children}
    </button>
  );
}

/** Machine value: address, hash, incident id. */
export function Mono({
  children,
  title,
  tone = "neutral",
}: {
  children: ReactNode;
  title?: string;
  tone?: Tone;
}) {
  return (
    <span className={`font-mono text-xs ${TONE_TEXT[tone]}`} title={title}>
      {children}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="py-6 text-center text-xs text-[var(--color-ink-faint)]">{children}</p>
  );
}

/** Explicit label for anything that did not come from a chain. */
export function SimulatedBadge({ reason }: { reason?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--color-warn)]"
      title={reason ?? "This value is simulated, not read from a blockchain."}
    >
      <span aria-hidden="true">◐</span> Simulated
    </span>
  );
}
