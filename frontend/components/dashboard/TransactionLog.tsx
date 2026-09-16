import { formatDuration, shortenHash } from "@/lib/formatters";
import { EmptyState, Panel, StatusPill, type Tone } from "@/components/ui/primitives";
import type { TransactionPhase, TransactionState } from "@/lib/types";

const TONE: Record<TransactionPhase, Tone> = {
  idle: "neutral",
  "awaiting-wallet": "info",
  submitted: "info",
  pending: "warn",
  confirmed: "ok",
  failed: "crit",
};

const LABEL: Record<TransactionPhase, string> = {
  idle: "Idle",
  "awaiting-wallet": "Wallet",
  submitted: "Submitted",
  pending: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
};

const GLYPH: Record<TransactionPhase, string> = {
  idle: "○",
  "awaiting-wallet": "◌",
  submitted: "◍",
  pending: "◍",
  confirmed: "✓",
  failed: "✕",
};

/**
 * Transaction log.
 *
 * `confirmed` here means the node reported the contract EXECUTED successfully.
 * A transaction that settled as ACCEPTED or FINALIZED with an execution error
 * shows as failed, because on GenLayer that combination means no state changed.
 */
export function TransactionLog({ transactions }: { transactions: TransactionState[] }) {
  return (
    <Panel title="Transactions" subtitle="Execution result, not just lifecycle status">
      {transactions.length === 0 ? (
        <EmptyState>No transactions in this session.</EmptyState>
      ) : (
        <ul className="space-y-1.5" aria-live="polite">
          {transactions.slice(0, 12).map((tx) => (
            <li
              key={tx.id}
              className="rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-xs text-[var(--color-ink)]">
                  {tx.label}
                  {tx.simulated && (
                    <span className="font-mono text-[9px] uppercase tracking-wider text-[var(--color-warn)]">
                      simulated
                    </span>
                  )}
                </span>
                <StatusPill tone={TONE[tx.phase]} glyph={GLYPH[tx.phase]}>
                  {LABEL[tx.phase]}
                </StatusPill>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 font-mono text-[10px] text-[var(--color-ink-faint)]">
                {tx.hash && <span title={tx.hash}>{shortenHash(tx.hash)}</span>}
                {tx.statusName && <span>status {tx.statusName}</span>}
                {tx.executionResult && <span>exec {tx.executionResult}</span>}
                {tx.endedAt && (
                  <span>{formatDuration(Math.round((tx.endedAt - tx.startedAt) / 1000))}</span>
                )}
              </div>

              {tx.error && (
                <p className="mt-1 break-words rounded border border-[var(--color-crit)]/40 bg-[var(--color-crit)]/10 px-2 py-1 font-mono text-[10px] text-[var(--color-crit)]">
                  {tx.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
