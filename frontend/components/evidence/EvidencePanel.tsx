import { SIGNAL_LABELS, SIGNAL_NAMES, type Incident, type SignalName } from "@/lib/types";
import { formatBps, formatDateTime, parseMetadata, shortenHash } from "@/lib/formatters";
import { EmptyState, Mono, Panel, StatusPill } from "@/components/ui/primitives";

/**
 * Evidence, as structured readings rather than a wall of text.
 *
 * The framing matters: what is shown here is INPUT to the adjudication. The
 * signal rows below are what the evaluation concluded, and neither the readings
 * nor the signals decide the response — `derive_level()` does.
 */
export function EvidencePanel({ incident }: { incident: Incident | null }) {
  if (!incident) {
    return (
      <Panel title="Evidence">
        <EmptyState>No incident selected.</EmptyState>
      </Panel>
    );
  }

  const claimed = parseMetadata(incident.evidence.metadataJson);
  const signals = incident.evaluation?.signals ?? null;

  const claimRows: Array<[string, string]> = [
    ["Oracle deviation", claimed.deviation_bps !== undefined ? formatBps(claimed.deviation_bps) : "not claimed"],
    ["Liquidity delta", claimed.liquidity_delta_bps !== undefined ? `-${formatBps(claimed.liquidity_delta_bps)}` : "not claimed"],
    ["Borrow window volume", claimed.window_volume_bps !== undefined ? formatBps(claimed.window_volume_bps) : "not claimed"],
    ["Top sender share", claimed.top_sender_share_bps !== undefined ? formatBps(claimed.top_sender_share_bps) : "not claimed"],
  ];

  return (
    <Panel title="Evidence" subtitle="Input to adjudication — not the decision">
      <dl className="grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
            Category
          </dt>
          <dd className="mt-0.5 font-mono text-[var(--color-ink)]">
            {incident.evidence.category || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
            Observed at
          </dt>
          <dd className="mt-0.5 font-mono text-[var(--color-ink)]">
            {formatDateTime(incident.evidence.observedAtTs)}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
            Evidence hash
          </dt>
          <dd className="mt-0.5">
            <Mono title={incident.evidence.evidenceHash}>
              {shortenHash(incident.evidence.evidenceHash)}
            </Mono>
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
            Evidence reference
          </dt>
          <dd className="mt-0.5 break-all">
            {/* Rendered as inert text. The console never fetches a
                reporter-supplied URL, and never renders it as a link. */}
            <Mono>{incident.evidence.evidenceUri || "—"}</Mono>
          </dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-[var(--color-line)] pt-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
          Claimed by reporter · untrusted
        </h3>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {claimRows.map(([label, value]) => (
            <li key={label} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-[var(--color-ink-dim)]">{label}</span>
              <span className="font-mono tabular text-[var(--color-ink)]">{value}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 border-t border-[var(--color-line)] pt-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
          Signals raised by the evaluation
        </h3>
        {!signals ? (
          <EmptyState>Not yet adjudicated.</EmptyState>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {SIGNAL_NAMES.map((name: SignalName) => {
              const on = signals[name];
              const warning = name === "evidence_inconsistent";
              return (
                <li
                  key={name}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="uppercase tracking-wide text-[var(--color-ink-dim)]">
                    {SIGNAL_LABELS[name]}
                  </span>
                  {on ? (
                    <StatusPill tone={warning ? "warn" : "crit"} glyph="✓">
                      Detected
                    </StatusPill>
                  ) : (
                    <StatusPill tone="neutral" glyph="—">
                      Not detected
                    </StatusPill>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
