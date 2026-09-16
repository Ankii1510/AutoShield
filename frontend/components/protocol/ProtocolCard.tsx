import {
  formatAttoCompact,
  formatBps,
  shortenAddress,
} from "@/lib/formatters";
import { Metric, Mono, Panel, StatusPill, type Tone } from "@/components/ui/primitives";
import type { ProtocolMode, ProtocolStatus, ProtocolTelemetry } from "@/lib/types";

const MODE_TONE: Record<ProtocolMode, Tone> = {
  NORMAL: "ok",
  RESTRICTED: "warn",
  HALTED: "crit",
};

const MODE_GLYPH: Record<ProtocolMode, string> = {
  NORMAL: "●",
  RESTRICTED: "◐",
  HALTED: "■",
};

export function ProtocolCard({
  status,
  telemetry,
  incidentCount,
  protocolAddress,
}: {
  status: ProtocolStatus | null;
  telemetry: ProtocolTelemetry | null;
  incidentCount: number;
  protocolAddress: string;
}) {
  const mode = status?.mode ?? "NORMAL";

  return (
    <Panel
      title="Protected protocol"
      actions={
        <StatusPill tone={MODE_TONE[mode]} glyph={MODE_GLYPH[mode]}>
          {mode}
        </StatusPill>
      }
    >
      <div className="mb-4">
        <h3 className="text-base font-semibold text-[var(--color-ink)]">
          DemoLendingProtocol
        </h3>
        <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
          Controlled demo market ·{" "}
          <Mono title={protocolAddress}>{shortenAddress(protocolAddress, 6)}</Mono>
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Metric
          label="Total value locked"
          value={telemetry ? formatAttoCompact(telemetry.totalDepositsAtto) : "—"}
          hint="Simulated demo units"
        />
        <Metric
          label="Borrowed"
          value={telemetry ? formatAttoCompact(telemetry.totalBorrowedAtto) : "—"}
          hint={telemetry ? `${formatBps(telemetry.utilisationBps, 1)} utilisation` : undefined}
        />
        <Metric
          label="Protection level"
          value={mode}
          tone={MODE_TONE[mode]}
          hint={status?.activeIncidentId ? `via ${status.activeIncidentId}` : "no active response"}
        />
        <Metric
          label="Incidents"
          value={incidentCount}
          hint={
            status && status.consecutiveHalts > 0
              ? `${status.consecutiveHalts} consecutive halts`
              : "since deployment"
          }
        />
      </dl>

      <ul className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--color-line)] pt-3 text-[11px] sm:grid-cols-4">
        <OperationFlag label="Supply" enabled={status?.supplyEnabled ?? true} />
        <OperationFlag label="Borrow" enabled={status?.borrowEnabled ?? true} />
        <OperationFlag label="Withdraw" enabled={status?.withdrawEnabled ?? true} />
        <OperationFlag label="Repay" enabled={status?.repayEnabled ?? true} always />
      </ul>
    </Panel>
  );
}

function OperationFlag({
  label,
  enabled,
  always,
}: {
  label: string;
  enabled: boolean;
  always?: boolean;
}) {
  return (
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={enabled ? "text-[var(--color-ok)]" : "text-[var(--color-crit)]"}
      >
        {enabled ? "✓" : "✕"}
      </span>
      <span className="text-[var(--color-ink-dim)]">{label}</span>
      <span className="sr-only">{enabled ? "enabled" : "blocked"}</span>
      {always && (
        <span
          className="text-[10px] text-[var(--color-ink-faint)]"
          title="Repayment is never blocked in any mode, by design."
        >
          always
        </span>
      )}
    </li>
  );
}
