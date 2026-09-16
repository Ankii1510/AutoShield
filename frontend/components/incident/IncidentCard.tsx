import Link from "next/link";

import {
  formatClock,
  formatDuration,
  shortenAddress,
  shortenHash,
} from "@/lib/formatters";
import {
  EmptyState,
  Mono,
  Panel,
  StatusPill,
  type Tone,
} from "@/components/ui/primitives";
import { LEVEL_GLYPH, LEVEL_TONE } from "@/components/incident/DecisionPanel";
import type { Incident, IncidentStatus, TransactionState } from "@/lib/types";

export const STATUS_TONE: Record<IncidentStatus, Tone> = {
  READY: "info",
  EVALUATED: "warn",
  APPLIED: "crit",
  DISMISSED: "ok",
  STALE: "neutral",
};

export function IncidentCard({
  incident,
  latestTx,
  now,
}: {
  incident: Incident | null;
  latestTx: TransactionState | null;
  now: number;
}) {
  if (!incident) {
    return (
      <Panel title="Current incident">
        <EmptyState>
          No incident yet. Run a simulation to create one.
        </EmptyState>
      </Panel>
    );
  }

  const evaluation = incident.evaluation;
  const remaining =
    incident.deadlineTs > 0 ? Math.max(0, incident.deadlineTs - now) : 0;

  return (
    <Panel
      title="Current incident"
      actions={
        <div className="flex items-center gap-2">
          <StatusPill tone={STATUS_TONE[incident.status]}>{incident.status}</StatusPill>
          {incident.level && (
            <StatusPill tone={LEVEL_TONE[incident.level]} glyph={LEVEL_GLYPH[incident.level]}>
              {incident.level}
            </StatusPill>
          )}
        </div>
      }
    >
      <dl className="grid gap-x-4 gap-y-3 text-xs sm:grid-cols-2">
        <Field label="Incident ID">
          <Link
            href={`/incidents/${encodeURIComponent(incident.incidentId)}`}
            className="font-mono text-[var(--color-info)] underline-offset-2 hover:underline"
          >
            {incident.incidentId}
          </Link>
        </Field>
        <Field label="Created">
          <Mono>{formatClock(incident.createdAtTs)}</Mono>
        </Field>
        <Field label="Reporter">
          <Mono title={incident.reporter}>{shortenAddress(incident.reporter, 5)}</Mono>
        </Field>
        <Field label="Evidence">
          <Mono title={incident.evidence.evidenceHash}>
            {shortenHash(incident.evidence.evidenceHash)}
          </Mono>
        </Field>
        <Field label="Severity">
          {evaluation ? (
            <span className="font-mono tabular text-[var(--color-ink)]">
              {evaluation.severity} / 100
            </span>
          ) : (
            <Mono>not adjudicated</Mono>
          )}
        </Field>
        <Field label="Signals">
          {evaluation ? (
            <span className="font-mono text-[var(--color-ink)]">
              {countSignals(evaluation.signalsBits)} of 6
            </span>
          ) : (
            <Mono>—</Mono>
          )}
        </Field>
        <Field label="Final response">
          {incident.level ? (
            <span className="font-mono text-[var(--color-ink)]">{incident.level}</span>
          ) : (
            <Mono>pending</Mono>
          )}
        </Field>
        <Field label="Response expiry">
          {remaining > 0 ? (
            <span className="font-mono tabular text-[var(--color-ink)]">
              {formatDuration(remaining)}
            </span>
          ) : (
            <Mono>{incident.deadlineTs > 0 ? "expired" : "n/a"}</Mono>
          )}
        </Field>
      </dl>

      <div className="mt-4 border-t border-[var(--color-line)] pt-3">
        <TransactionStatusLine tx={latestTx} />
      </div>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
        {label}
      </dt>
      <dd className="mt-0.5 truncate">{children}</dd>
    </div>
  );
}

export function countSignals(bits: number): number {
  let count = 0;
  for (let i = 0; i < 6; i += 1) if ((bits >> i) & 1) count += 1;
  return count;
}

const TX_TONE: Record<TransactionState["phase"], Tone> = {
  idle: "neutral",
  "awaiting-wallet": "info",
  submitted: "info",
  pending: "warn",
  confirmed: "ok",
  failed: "crit",
};

const TX_LABEL: Record<TransactionState["phase"], string> = {
  idle: "Idle",
  "awaiting-wallet": "Awaiting wallet confirmation",
  submitted: "Submitted",
  pending: "Pending / finalizing",
  confirmed: "Confirmed",
  failed: "Failed",
};

const TX_GLYPH: Record<TransactionState["phase"], string> = {
  idle: "○",
  "awaiting-wallet": "◌",
  submitted: "◍",
  pending: "◍",
  confirmed: "✓",
  failed: "✕",
};

export function TransactionStatusLine({ tx }: { tx: TransactionState | null }) {
  if (!tx) {
    return (
      <p className="text-[11px] text-[var(--color-ink-faint)]">
        No transaction in flight.
      </p>
    );
  }

  return (
    <div aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[var(--color-ink-dim)]">{tx.label}</span>
        <StatusPill tone={TX_TONE[tx.phase]} glyph={TX_GLYPH[tx.phase]}>
          {TX_LABEL[tx.phase]}
        </StatusPill>
      </div>
      {tx.hash && (
        <p className="mt-1 font-mono text-[10px] text-[var(--color-ink-faint)]">
          {shortenHash(tx.hash)}
          {tx.statusName && ` · ${tx.statusName}`}
          {tx.executionResult && ` · execution ${tx.executionResult}`}
        </p>
      )}
      {tx.error && (
        <p className="mt-1 rounded border border-[var(--color-crit)]/40 bg-[var(--color-crit)]/10 px-2 py-1 font-mono text-[10px] text-[var(--color-crit)]">
          {tx.error}
        </p>
      )}
    </div>
  );
}
