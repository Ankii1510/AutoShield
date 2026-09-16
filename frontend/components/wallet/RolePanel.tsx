import { Panel, StatusPill } from "@/components/ui/primitives";
import { shortenAddress } from "@/lib/formatters";
import type { ConsoleMode, OperatorRoles } from "@/lib/types";

/**
 * What THIS wallet may do, read from the contract.
 *
 * AutoShield is a guarded security system, not an open dapp. Reporting is
 * allowlisted and adjudication belongs to a single evaluator address, because
 * unauthenticated reporting would be a free denial-of-service surface against
 * the protocol being protected: anyone could file incidents until the open
 * slots filled up. That restriction is the design working, not a gap in it.
 *
 * Two actions are permissionless on purpose — executing a response that has
 * already been adjudicated, and expiring a stale incident — because both only
 * move the system toward safety or toward recovery, and neither should depend
 * on one key being online.
 *
 * A visitor therefore sees exactly which actions their own wallet can take,
 * rather than buttons that look available and fail on submission.
 */
export function RolePanel({
  roles,
  mode,
  connected,
}: {
  roles: OperatorRoles | null;
  mode: ConsoleMode;
  connected: boolean;
}) {
  if (mode === "demo") {
    return (
      <Panel title="Your permissions">
        <p className="text-xs leading-relaxed text-[var(--color-ink-dim)]">
          Demo mode needs no wallet and no permissions — every action below is
          simulated locally and nothing is signed.
        </p>
      </Panel>
    );
  }

  if (!connected || !roles) {
    return (
      <Panel title="Your permissions">
        <p className="text-xs leading-relaxed text-[var(--color-ink-dim)]">
          Not connected. <strong>Reading needs no wallet</strong> — everything on
          this screen is public on-chain state. Connect a wallet only to act.
        </p>
      </Panel>
    );
  }

  const canWriteSomething = roles.isReporter || roles.isEvaluator || roles.isOwner;

  const CAPABILITIES: Array<{ label: string; allowed: boolean; why: string }> = [
    {
      label: "Report an incident",
      allowed: roles.isReporter,
      why: roles.isReporter
        ? "on the reporter allowlist"
        : "allowlisted addresses only — this blocks incident spam",
    },
    {
      label: "Run adjudication",
      allowed: roles.isEvaluator,
      why: roles.isEvaluator
        ? "this wallet is the evaluator"
        : "the evaluator address only",
    },
    {
      label: "Execute an adjudicated response",
      allowed: true,
      why: "permissionless by design — protection must not wait for one key",
    },
    {
      label: "Expire a stale incident",
      allowed: true,
      why: "permissionless by design — recovery must not wait for one key",
    },
    {
      label: "Owner override (clear response, pause)",
      allowed: roles.isOwner,
      why: roles.isOwner ? "this wallet is the owner" : "the deploying owner only",
    },
  ];

  return (
    <Panel title="Your permissions">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-[var(--color-ink-faint)]">
          {shortenAddress(roles.address, 6)}
        </span>
        {roles.isOwner && <StatusPill tone="ok">Owner</StatusPill>}
        {roles.isEvaluator && <StatusPill tone="ok">Evaluator</StatusPill>}
        {roles.isReporter && <StatusPill tone="ok">Reporter</StatusPill>}
        {!canWriteSomething && <StatusPill tone="warn">Observer</StatusPill>}
      </div>

      <ul className="space-y-1.5">
        {CAPABILITIES.map((capability) => (
          <li
            key={capability.label}
            className="flex items-start gap-2 text-[11px] leading-relaxed"
          >
            <span
              aria-hidden="true"
              className={
                capability.allowed
                  ? "text-[var(--color-ok)]"
                  : "text-[var(--color-ink-faint)]"
              }
            >
              {capability.allowed ? "✓" : "✕"}
            </span>
            <span>
              <span
                className={
                  capability.allowed
                    ? "text-[var(--color-ink)]"
                    : "text-[var(--color-ink-faint)] line-through"
                }
              >
                {capability.label}
              </span>
              <span className="sr-only">
                {capability.allowed ? " — permitted" : " — not permitted"}
              </span>
              <span className="text-[var(--color-ink-faint)]"> · {capability.why}</span>
            </span>
          </li>
        ))}
      </ul>

      {!canWriteSomething && (
        <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          This wallet can read everything and execute or expire an existing
          incident, but cannot open one. That is deliberate: an open reporting
          endpoint would let anyone flood the protected protocol with incidents.
          To try the full flow yourself, switch to <strong>Demo mode</strong>, which
          needs no wallet at all.
        </p>
      )}
    </Panel>
  );
}
