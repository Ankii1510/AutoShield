"use client";

import { SCENARIOS, type Scenario } from "@/lib/demo/scenarios";
import { Button, Panel, StatusPill, type Tone } from "@/components/ui/primitives";

const OUTLOOK_TONE: Record<Scenario["outlook"], Tone> = {
  benign: "ok",
  suspicious: "warn",
  critical: "crit",
};

/**
 * Attack simulator.
 *
 * Every scenario is a set of owner-only calls on the demo protocol that move
 * only its own reported telemetry. There is no exploit mechanic here and
 * nothing outside the demo contract is touched.
 */
export function AttackSimulator({
  selectedId,
  onSelect,
  onSimulate,
  onSubmit,
  onRunFullDemo,
  onReset,
  busy,
  hasIncident,
  canSubmit,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
  onSimulate: (scenario: Scenario) => void;
  onSubmit: (scenario: Scenario) => void;
  onRunFullDemo: (scenario: Scenario) => void;
  onReset: () => void;
  busy: boolean;
  hasIncident: boolean;
  canSubmit: boolean;
}) {
  const selected = SCENARIOS.find((s) => s.id === selectedId) ?? SCENARIOS[0]!;

  return (
    <Panel
      title="Incident simulator"
      subtitle="Controlled demo protocol only — no exploit code, no external protocol"
      actions={
        <Button variant="ghost" onClick={onReset} disabled={busy}>
          Reset
        </Button>
      }
    >
      <fieldset disabled={busy}>
        <legend className="sr-only">Choose a simulation scenario</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {SCENARIOS.map((scenario) => {
            const active = scenario.id === selected.id;
            return (
              <button
                key={scenario.id}
                type="button"
                onClick={() => onSelect(scenario.id)}
                aria-pressed={active}
                className={`rounded border px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                  active
                    ? "border-[var(--color-info)]/60 bg-[var(--color-info)]/10"
                    : "border-[var(--color-line)] bg-[var(--color-surface-2)] hover:border-[var(--color-line-bright)]"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--color-ink)]">
                    {scenario.name}
                  </span>
                  <StatusPill tone={OUTLOOK_TONE[scenario.outlook]}>
                    {scenario.outlook}
                  </StatusPill>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <p className="mt-3 text-xs leading-relaxed text-[var(--color-ink-dim)]">
        {selected.blurb}
      </p>

      <div className="mt-4 rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
          Expected change in the monitor
        </h3>
        <table className="mt-2 w-full text-xs">
          <thead className="sr-only">
            <tr>
              <th>Metric</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {selected.expected.map((row) => (
              <tr key={row.label}>
                <td className="py-1 pr-2 text-[var(--color-ink-dim)]">{row.label}</td>
                <td className="py-1 pr-2 text-right font-mono tabular text-[var(--color-ink-faint)]">
                  {row.before}
                </td>
                <td className="py-1 pl-2 text-right font-mono tabular">
                  <span
                    className={
                      row.trend === "flat"
                        ? "text-[var(--color-ink-dim)]"
                        : "text-[var(--color-crit)]"
                    }
                  >
                    <span aria-hidden="true">
                      {row.trend === "up" ? "▲ " : row.trend === "down" ? "▼ " : ""}
                    </span>
                    {row.after}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <Button onClick={() => onSimulate(selected)} disabled={busy} full>
          1 · Simulate incident
        </Button>
        <Button
          onClick={() => onSubmit(selected)}
          disabled={busy || !canSubmit}
          title={canSubmit ? undefined : "Run the simulation first"}
          full
        >
          2 · Submit for adjudication
        </Button>
      </div>

      <div className="mt-2">
        <Button variant="primary" onClick={() => onRunFullDemo(selected)} disabled={busy} full>
          ▶ Run full demo — simulate, report, adjudicate, respond
        </Button>
      </div>

      {hasIncident && (
        <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
          An incident is already open. Submitting again creates a new one, subject to the
          reporter cooldown enforced on-chain.
        </p>
      )}
    </Panel>
  );
}
