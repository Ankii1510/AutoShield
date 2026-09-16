"use client";

import Link from "next/link";
import { use } from "react";

import { useAutoShield } from "@/lib/state/useAutoShield";
import { DecisionPanel } from "@/components/incident/DecisionPanel";
import { EvidencePanel } from "@/components/evidence/EvidencePanel";
import { IncidentTimeline } from "@/components/timeline/IncidentTimeline";
import { TransactionLog } from "@/components/dashboard/TransactionLog";
import { ValidatorPanel } from "@/components/validators/ValidatorPanel";
import { STATUS_TONE, countSignals } from "@/components/incident/IncidentCard";
import { LEVEL_GLYPH, LEVEL_TONE } from "@/components/incident/DecisionPanel";
import {
  EmptyState,
  Mono,
  Panel,
  StatusPill,
} from "@/components/ui/primitives";
import {
  MODE_FOR_LEVEL,
  formatDateTime,
  formatDuration,
  shortenAddress,
  shortenHash,
} from "@/lib/formatters";

export default function IncidentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const incidentId = decodeURIComponent(id);
  const app = useAutoShield();

  const incident = app.incidents.find((i) => i.incidentId === incidentId) ?? null;
  const now = app.now;
  const remaining = incident && incident.deadlineTs > 0 ? Math.max(0, incident.deadlineTs - now) : 0;

  return (
    <div className="mx-auto max-w-[1400px]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="text-xs text-[var(--color-info)] underline-offset-2 hover:underline"
          >
            ← Console
          </Link>
          <h1 className="font-mono text-sm text-[var(--color-ink)]">{incidentId}</h1>
        </div>
        {incident && (
          <div className="flex items-center gap-2">
            <StatusPill tone={STATUS_TONE[incident.status]}>{incident.status}</StatusPill>
            {incident.level && (
              <StatusPill
                tone={LEVEL_TONE[incident.level]}
                glyph={LEVEL_GLYPH[incident.level]}
              >
                {incident.level}
              </StatusPill>
            )}
          </div>
        )}
      </header>

      <main id="main" className="space-y-3 p-3 sm:p-4">
        {!incident ? (
          <Panel title="Incident">
            <EmptyState>
              No incident with this id in the current session. It may belong to a
              different node, or the console may still be loading.
            </EmptyState>
          </Panel>
        ) : (
          <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="space-y-3">
              {/* A. Summary */}
              <Panel title="A · Incident summary">
                <dl className="grid gap-x-4 gap-y-3 text-xs sm:grid-cols-3">
                  <Field label="Incident ID">
                    <Mono>{incident.incidentId}</Mono>
                  </Field>
                  <Field label="Created">
                    <Mono>{formatDateTime(incident.createdAtTs)}</Mono>
                  </Field>
                  <Field label="Status">
                    <Mono>{incident.status}</Mono>
                  </Field>
                  <Field label="Reporter">
                    <Mono title={incident.reporter}>
                      {shortenAddress(incident.reporter, 6)}
                    </Mono>
                  </Field>
                  <Field label="Protected protocol">
                    <Mono title={incident.protocol}>
                      {shortenAddress(incident.protocol, 6)}
                    </Mono>
                  </Field>
                  <Field label="Executed">
                    <Mono>{incident.executed ? "yes" : "no"}</Mono>
                  </Field>
                </dl>
              </Panel>

              {/* B. Evidence */}
              <EvidencePanel incident={incident} />

              {/* C + D. Evaluation and validators */}
              <div className="grid gap-3 lg:grid-cols-2">
                <Panel title="C · GenLayer evaluation">
                  {!incident.evaluation ? (
                    <EmptyState>Not yet adjudicated.</EmptyState>
                  ) : (
                    <dl className="grid gap-3 text-xs">
                      <Field label="Severity">
                        <span className="font-mono tabular text-lg text-[var(--color-ink)]">
                          {incident.evaluation.severity}
                          <span className="text-[var(--color-ink-faint)]"> / 100</span>
                        </span>
                      </Field>
                      <Field label="Signal flags set">
                        <Mono>
                          {countSignals(incident.evaluation.signalsBits)} of 6 · bits{" "}
                          {incident.evaluation.signalsBits}
                        </Mono>
                      </Field>
                      <Field label="Evaluated at">
                        <Mono>{formatDateTime(incident.evaluation.evaluatedAtTs)}</Mono>
                      </Field>
                      <p className="text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
                        The evaluation returns exactly seven values: one integer and six
                        booleans. No prose is part of the consensus value, and no model
                        reasoning is stored or displayed.
                      </p>
                    </dl>
                  )}
                </Panel>

                <ValidatorPanel consensus={app.consensus} evaluating={false} />
              </div>

              {/* E. Deterministic decision */}
              <DecisionPanel
                incident={incident}
                config={app.config}
                derivedLevel={app.derivedLevel}
              />

              {/* F. Protocol response */}
              <Panel title="F · Protocol response">
                {!incident.level || incident.level === "SAFE" ? (
                  <p className="text-xs text-[var(--color-ink-dim)]">
                    No protective action. A SAFE verdict never touches the protocol.
                  </p>
                ) : (
                  <dl className="grid gap-x-4 gap-y-3 text-xs sm:grid-cols-3">
                    <Field label="Response level">
                      <Mono>{incident.level}</Mono>
                    </Field>
                    <Field label="Protocol mode">
                      <Mono>{MODE_FOR_LEVEL[incident.level]}</Mono>
                    </Field>
                    <Field label="Applied">
                      <Mono>{incident.executed ? "yes" : "not yet"}</Mono>
                    </Field>
                    <Field label="Expires at">
                      <Mono>{formatDateTime(incident.deadlineTs)}</Mono>
                    </Field>
                    <Field label="Time remaining">
                      <Mono>{remaining > 0 ? formatDuration(remaining) : "expired"}</Mono>
                    </Field>
                    <Field label="Current protocol mode">
                      <Mono>{app.status?.mode ?? "—"}</Mono>
                    </Field>
                  </dl>
                )}
                <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
                  Every response carries an absolute deadline the protocol enforces
                  itself, and decays without any transaction: HALT steps down to
                  RESTRICTED, then to NORMAL. Repayment is never blocked in any mode.
                </p>
              </Panel>
            </div>

            {/* G. History */}
            <div className="space-y-3">
              <IncidentTimeline events={app.timeline} />
              <TransactionLog transactions={app.transactions} />
              <Panel title="Evidence reference">
                <p className="break-all font-mono text-[11px] text-[var(--color-ink-faint)]">
                  {shortenHash(incident.evidence.evidenceHash)}
                </p>
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
                  Only a hash, a pointer and compact metadata are stored on-chain. The
                  reference is never fetched by the contract or by this console:
                  retrieving a reporter-supplied URL would be an SSRF vector and would
                  make the evaluation non-reproducible between validators.
                </p>
              </Panel>
            </div>
          </div>
        )}
      </main>
    </div>
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
