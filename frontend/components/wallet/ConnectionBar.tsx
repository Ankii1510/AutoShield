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
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="text-[var(--color-info)]">
            ▰
          </span>
          <span className="text-sm font-semibold tracking-tight text-[var(--color-ink)]">
            AutoShield
          </span>
          <span className="hidden text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)] sm:inline">
            Security Operations Console
          </span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
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
