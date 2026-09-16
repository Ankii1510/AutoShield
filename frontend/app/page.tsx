"use client";

import Link from "next/link";

import { useAutoShield } from "@/lib/state/useAutoShield";
import { AttackSimulator } from "@/components/simulator/AttackSimulator";
import { ConnectionBar } from "@/components/wallet/ConnectionBar";
import { DecisionPanel } from "@/components/incident/DecisionPanel";
import { EvidencePanel } from "@/components/evidence/EvidencePanel";
import { FlowDiagram } from "@/components/dashboard/FlowDiagram";
import { IncidentCard } from "@/components/incident/IncidentCard";
import { IncidentTimeline } from "@/components/timeline/IncidentTimeline";
import { ProtectionState } from "@/components/protocol/ProtectionState";
import { ProtocolCard } from "@/components/protocol/ProtocolCard";
import { RolePanel } from "@/components/wallet/RolePanel";
import { ThreatMonitor } from "@/components/protocol/ThreatMonitor";
import { TransactionLog } from "@/components/dashboard/TransactionLog";
import { ValidatorPanel } from "@/components/validators/ValidatorPanel";
import { Button, Panel, StatusPill } from "@/components/ui/primitives";
import { STATUS_TONE } from "@/components/incident/IncidentCard";
import { formatClock } from "@/lib/formatters";

export default function DashboardPage() {
  const app = useAutoShield();

  const latestTx = app.transactions[0] ?? null;
  const now = app.now;
  // Permission comes from the contract, not from the UI's own opinion. The
  // button is still rendered when a role is missing -- hiding it would hide
  // the reason -- but it is disabled and says why.
  const mayReport = app.mode === "demo" || app.roles?.isReporter === true;
  const mayAdjudicate = app.mode === "demo" || app.roles?.isEvaluator === true;
  const mayOverride = app.mode === "demo" || app.roles?.isOwner === true;

  const canAdjudicate = app.currentIncident?.status === "READY";
  const canExecute =
    app.currentIncident?.status === "EVALUATED" &&
    (app.currentIncident.level === "PROTECT" || app.currentIncident.level === "HALT");

  return (
    <div className="mx-auto max-w-[1600px]">
      <ConnectionBar
        connection={app.connection}
        mode={app.mode}
        onModeChange={app.setMode}
        onConnect={() => void app.connect()}
        chainAvailable={Boolean(process.env.NEXT_PUBLIC_AUTOSHIELD_ADDRESS)}
        busy={app.loading}
      />

      <main id="main" className="space-y-3 p-3 sm:p-4">
        <FlowDiagram stage={app.stage} />

        {app.error && (
          <p
            role="alert"
            className="rounded border border-[var(--color-crit)]/40 bg-[var(--color-crit)]/10 px-3 py-2 text-xs text-[var(--color-crit)]"
          >
            {app.error}
          </p>
        )}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {/* ---------------------------------------------- primary column */}
          <div className="space-y-3">
            <ProtocolCard
              status={app.status}
              telemetry={app.telemetry}
              incidentCount={app.config?.incidentCount ?? app.incidents.length}
              protocolAddress={app.config?.protocolAddress ?? "—"}
            />

            <div className="grid gap-3 lg:grid-cols-2">
              <ProtectionState status={app.status} now={now} />
              <ThreatMonitor telemetry={app.telemetry} incident={app.currentIncident} />
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <IncidentCard
                incident={app.currentIncident}
                latestTx={latestTx}
                now={now}
              />
              <ValidatorPanel
                consensus={app.consensus}
                evaluating={app.stage === "adjudicating"}
              />
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <EvidencePanel incident={app.currentIncident} />
              <DecisionPanel
                incident={app.currentIncident}
                config={app.config}
                derivedLevel={app.derivedLevel}
              />
            </div>
          </div>

          {/* --------------------------------------------- operations rail */}
          <div className="space-y-3">
            <AttackSimulator
              selectedId={app.selectedScenarioId}
              onSelect={app.selectScenario}
              onSimulate={(scenario) => void app.runSimulation(scenario)}
              onSubmit={(scenario) => void app.reportIncident(scenario)}
              onRunFullDemo={(scenario) => void app.runFullDemo(scenario)}
              onReset={() => void app.resetSimulation()}
              busy={app.busy}
              hasIncident={Boolean(app.currentIncident)}
              canSubmit={Boolean(app.telemetry) && mayReport}
            />

            <Panel title="Operator actions">
              <div className="grid gap-2">
                <Button
                  variant="primary"
                  onClick={() => void app.adjudicate()}
                  disabled={app.busy || !canAdjudicate || !mayAdjudicate}
                  title={
                    !mayAdjudicate
                      ? "Only the evaluator address may adjudicate"
                      : canAdjudicate
                        ? undefined
                        : "Needs an incident awaiting evaluation"
                  }
                  full
                >
                  Run GenLayer adjudication
                </Button>
                <Button
                  onClick={() => void app.executeResponse()}
                  disabled={app.busy || !canExecute}
                  title={canExecute ? undefined : "Needs an adjudicated PROTECT or HALT"}
                  full
                >
                  Execute bounded response
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void app.clearResponse()}
                  disabled={app.busy || app.status?.mode === "NORMAL" || !mayOverride}
                  title={
                    mayOverride
                      ? "Owner override — the documented false-positive escape hatch"
                      : "Only the contract owner may clear a response"
                  }
                  full
                >
                  Owner override: clear response
                </Button>
                {app.mode === "demo" && (
                  <Button variant="ghost" onClick={app.fastForward} disabled={app.busy} full>
                    ⏩ Fast-forward to expiry (demo only)
                  </Button>
                )}
              </div>
            </Panel>

            <RolePanel
              roles={app.roles}
              mode={app.mode}
              connected={app.connection.connected}
            />

            <IncidentTimeline events={app.timeline} />
            <TransactionLog transactions={app.transactions} />

            <Panel title="Incident history">
              {app.incidents.length === 0 ? (
                <p className="py-4 text-center text-xs text-[var(--color-ink-faint)]">
                  No incidents recorded.
                </p>
              ) : (
                <ul className="space-y-1">
                  {app.incidents.slice(0, 8).map((incident) => (
                    <li key={incident.incidentId}>
                      <Link
                        href={`/incidents/${encodeURIComponent(incident.incidentId)}`}
                        className="flex items-center justify-between gap-2 rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-xs transition-colors hover:border-[var(--color-line-bright)]"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[var(--color-info)]">
                            {incident.incidentId}
                          </span>
                          <span className="font-mono text-[10px] text-[var(--color-ink-faint)]">
                            {formatClock(incident.createdAtTs)}
                          </span>
                        </span>
                        <StatusPill tone={STATUS_TONE[incident.status]}>
                          {incident.level || incident.status}
                        </StatusPill>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>

        <footer className="pb-6 pt-2 text-center text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          AutoShield protects a <strong>controlled demo</strong> lending protocol. The
          simulator contains no exploit code and touches no real DeFi protocol. The
          evaluation returns only a severity score and six boolean flags;{" "}
          <code>derive_level()</code> on-chain decides SAFE, PROTECT or HALT.
        </footer>
      </main>
    </div>
  );
}
