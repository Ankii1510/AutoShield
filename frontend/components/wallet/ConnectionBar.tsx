"use client";

import { shortenAddress } from "@/lib/formatters";
import { Button, StatusPill } from "@/components/ui/primitives";
import type { ConnectionState, ConsoleMode } from "@/lib/types";

/**
 * Connection bar: which backend the console is reading, and who is signing.
 *
 * The mode is never hidden. If the numbers on screen came from a simulation
 * rather than a chain, the header says so.
 */
export function ConnectionBar({
  connection,
  mode,
  onModeChange,
  onConnect,
  chainAvailable,
  busy,
}: {
  connection: ConnectionState;
  mode: ConsoleMode;
  onModeChange: (mode: ConsoleMode) => void;
  onConnect: () => void;
  chainAvailable: boolean;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-3">
      <div className="flex items-center gap-3">
        {/* A real mark rather than a glyph, and the wordmark given room to
            breathe: this bar is the first thing anyone sees, and a cramped
            monospace arrow was doing the product no favours. */}
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-info)] text-[13px] font-bold text-white shadow-[var(--shadow-panel)]"
          >
            A
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--color-ink)]">
              AutoShield
            </span>
            <span className="mt-1 hidden text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--color-ink-faint)] sm:inline">
              Security Operations Console
            </span>
          </span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* A protocol team evaluating AutoShield lands here, not on GitHub.
            The integration guide has to be reachable from the console itself
            or it may as well not exist. */}
        <a
          href="/integrate"
          className="hidden rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)] md:inline-block"
        >
          Integrate
        </a>
        <div
          role="group"
          aria-label="Data source"
          className="flex rounded border border-[var(--color-line-bright)] p-0.5"
        >
          <button
            type="button"
            onClick={() => onModeChange("chain")}
            disabled={!chainAvailable}
            aria-pressed={mode === "chain"}
            title={
              chainAvailable
                ? "Read live state from a GenLayer node"
                : "No contract addresses configured — run scripts/deploy-local.mjs"
            }
            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              mode === "chain"
                ? "bg-[var(--color-info)]/20 text-[var(--color-info)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            }`}
          >
            Live chain
          </button>
          <button
            type="button"
            onClick={() => onModeChange("demo")}
            aria-pressed={mode === "demo"}
            title="Run the full flow with no node. Everything is labelled simulated."
            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              mode === "demo"
                ? "bg-[var(--color-warn)]/20 text-[var(--color-warn)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            }`}
          >
            Demo mode
          </button>
        </div>

        {mode === "demo" ? (
          <StatusPill tone="warn" glyph="◐">
            Simulated — no chain
          </StatusPill>
        ) : connection.connected ? (
          <StatusPill
            tone={connection.warning ? "warn" : "ok"}
            glyph={connection.warning ? "⚠" : "⛓"}
          >
            Chain {connection.chainId ?? "?"}
          </StatusPill>
        ) : (
          <StatusPill tone="crit" glyph="✕">
            Disconnected
          </StatusPill>
        )}

        {mode === "chain" && (
          <>
            <span className="hidden font-mono text-[11px] text-[var(--color-ink-faint)] md:inline">
              {connection.address ? shortenAddress(connection.address, 5) : "no account"}
            </span>
            <Button onClick={onConnect} disabled={busy}>
              Connect wallet
            </Button>
          </>
        )}
      </div>

      {connection.warning && (
        <p
          role="alert"
          className="w-full rounded border border-[var(--color-crit)]/40 bg-[var(--color-crit)]/10 px-2 py-1 text-[11px] text-[var(--color-crit)]"
        >
          {connection.warning}
        </p>
      )}

      {connection.error && (
        <p
          role="status"
          className="w-full rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-2 py-1 text-[11px] text-[var(--color-warn)]"
        >
          {connection.error}
        </p>
      )}
    </div>
  );
}
