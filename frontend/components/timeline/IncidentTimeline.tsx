import { formatClock, shortenHash } from "@/lib/formatters";
import { EmptyState, Panel, type Tone } from "@/components/ui/primitives";
import type { IncidentTimelineEvent, TimelineKind } from "@/lib/types";

const KIND_TONE: Record<TimelineKind, Tone> = {
  detection: "warn",
  incident: "info",
  evidence: "info",
  adjudication: "info",
  consensus: "info",
  decision: "warn",
  response: "crit",
  recovery: "ok",
};

const KIND_GLYPH: Record<TimelineKind, string> = {
  detection: "▲",
  incident: "◆",
  evidence: "▪",
  adjudication: "◍",
  consensus: "⛓",
  decision: "✦",
  response: "■",
  recovery: "●",
};

export function IncidentTimeline({ events }: { events: IncidentTimelineEvent[] }) {
  return (
    <Panel title="Incident timeline">
      {events.length === 0 ? (
        <EmptyState>Nothing recorded in this session yet.</EmptyState>
      ) : (
        <ol className="space-y-0">
          {events.map((event, index) => {
            const tone = KIND_TONE[event.kind];
            const color =
              tone === "ok"
                ? "text-[var(--color-ok)]"
                : tone === "warn"
                  ? "text-[var(--color-warn)]"
                  : tone === "crit"
                    ? "text-[var(--color-crit)]"
                    : "text-[var(--color-info)]";
            return (
              <li key={event.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span aria-hidden="true" className={`text-xs leading-5 ${color}`}>
                    {KIND_GLYPH[event.kind]}
                  </span>
                  {index < events.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="w-px flex-1 bg-[var(--color-line-bright)]"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1 pb-4">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <time className="font-mono text-[11px] tabular text-[var(--color-ink-faint)]">
                      {formatClock(event.ts)}
                    </time>
                    <span className="text-xs text-[var(--color-ink)]">{event.label}</span>
                    {event.simulated && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-[var(--color-warn)]">
                        simulated
                      </span>
                    )}
                  </div>
                  {event.detail && (
                    <p className="mt-0.5 font-mono text-[11px] text-[var(--color-ink-faint)]">
                      {event.detail}
                    </p>
                  )}
                  {event.txHash && (
                    <p className="mt-0.5 font-mono text-[10px] text-[var(--color-ink-faint)]">
                      tx {shortenHash(event.txHash)}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
