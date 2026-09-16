import Link from "next/link";

import { Panel } from "@/components/ui/primitives";

export const metadata = {
  title: "Integrate AutoShield — what your protocol must implement",
  description:
    "The two methods a protocol implements to be guarded by AutoShield, the telemetry contract, and the limits, stated plainly.",
};

/**
 * The integration guide, on the site rather than only in the repository.
 *
 * A protocol team evaluating AutoShield arrives at the console, not at a
 * markdown file on GitHub. Every signature, key and threshold here is the one
 * the deployed contracts actually use — `docs/INTEGRATION.md` is the longer
 * version of this same material, and the two must not drift.
 *
 * This is a reading page, not a console panel: one measured column, generous
 * leading, and code that is large enough to copy from on a projector.
 */

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-4 text-[12.5px] leading-relaxed text-[var(--color-ink)]">
      <code className="font-mono">{children}</code>
    </pre>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-10 mb-3 text-[19px] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-4 text-[14.5px] leading-[1.7] text-[var(--color-ink-dim)]">
      {children}
    </p>
  );
}

const TELEMETRY = [
  ["deviation_bps", "oracle price vs. your baseline", "1500"],
  ["utilisation_bps", "borrowed ÷ deposits", "9000"],
  ["window_volume_bps", "borrow volume in a recent window", "5000"],
  ["liquidity_delta_bps", "drop in available liquidity", "3000"],
  ["top_sender_share_bps", "share from the busiest single sender", "8000"],
];

export default function IntegratePage() {
  return (
    <div className="mx-auto max-w-[1600px]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-info)] text-[13px] font-bold text-white shadow-[var(--shadow-panel)]"
          >
            A
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--color-ink)]">
              AutoShield
            </span>
            <span className="mt-1 hidden text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--color-ink-faint)] sm:inline">
              Integration guide
            </span>
          </span>
        </Link>
        <Link
          href="/"
          className="rounded-lg border border-[var(--color-line-bright)] bg-[var(--color-surface)] px-3.5 py-2 text-xs font-medium text-[var(--color-ink)] shadow-[var(--shadow-panel)] transition-all hover:bg-[var(--color-surface-2)]"
        >
          ← Back to console
        </Link>
      </header>

      <main id="main" className="px-4 py-8">
        <div className="mx-auto max-w-[760px]">
          <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.03em] text-[var(--color-ink)]">
            Putting AutoShield in front of your protocol
          </h1>
          <p className="mt-3 mb-2 text-[16px] leading-[1.65] text-[var(--color-ink-dim)]">
            Two methods on your contract, and one wiring call. That is the
            entire surface.
          </p>

          <Panel className="mt-6 p-5">
            <p className="text-[14px] leading-[1.7] text-[var(--color-ink-dim)]">
              AutoShield holds{" "}
              <strong className="font-semibold text-[var(--color-ink)]">
                one
              </strong>{" "}
              authority over your protocol: a single queued call to{" "}
              <code className="font-mono text-[13px] text-[var(--color-ink)]">
                apply_response
              </code>
              . It has no method that can move value, change your oracle, change
              your owner, or halt you indefinitely — not because it promises
              not to, but because no such code path exists.
            </p>
          </Panel>

          <H>1. What you implement</H>
          <Code>{`@gl.public.view
def telemetry(self) -> dict: ...

@gl.public.write
def apply_response(
    self, incident_id: str, level: str,
    deadline_ts: u256, severity: u256,
) -> str: ...`}</Code>
          <P>
            Plus one genesis call,{" "}
            <Mono>set_initial_guard(autoshield_address)</Mono>.
          </P>

          <H>2. The telemetry contract</H>
          <P>
            AutoShield calls <Mono>telemetry()</Mono> directly on your contract
            before every adjudication. It does not trust a reporter&apos;s copy of
            your metrics — the gap between what a reporter claims and what your
            contract reports is itself an input to the evaluation.
          </P>
          <P>
            Return a flat dict of integers. GenLayer calldata has no float type;
            a fractional value fails at the VM boundary before your code runs.
            All five below are <strong className="font-semibold text-[var(--color-ink)]">basis points</strong> — 1% = 100, 100% = 10000.
          </P>

          <div className="mb-4 overflow-x-auto rounded-lg border border-[var(--color-line)]">
            <table className="w-full text-left text-[13.5px]">
              <thead className="bg-[var(--color-surface-2)]">
                <tr className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-ink-dim)]">
                  <th className="px-4 py-2.5 font-semibold">Key</th>
                  <th className="px-4 py-2.5 font-semibold">Meaning</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Flags at</th>
                </tr>
              </thead>
              <tbody>
                {TELEMETRY.map(([key, meaning, threshold]) => (
                  <tr key={key} className="border-t border-[var(--color-line)]">
                    <td className="px-4 py-2.5 font-mono text-[12.5px] text-[var(--color-ink)]">
                      {key}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-ink-dim)]">{meaning}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular text-[var(--color-ink)]">
                      {threshold}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <P>
            Also read: <Mono>mode</Mono>, <Mono>total_deposits_atto</Mono>,{" "}
            <Mono>total_borrowed_atto</Mono>, <Mono>seconds_since_update</Mono>.
          </P>

          <Panel className="mb-4 border-[var(--color-warn)]/40 bg-[var(--color-warn)]/[0.07] p-5">
            <h3 className="mb-2 text-[13px] font-semibold text-[var(--color-warn)]">
              The unit trap
            </h3>
            <p className="text-[14px] leading-[1.7] text-[var(--color-ink-dim)]">
              AutoShield reads every metric with{" "}
              <Mono>observed.get(name, 0)</Mono>. A key you do not return is read
              as <strong className="font-semibold text-[var(--color-ink)]">zero</strong>,
              which looks exactly like &ldquo;nothing anomalous&rdquo;. There is no
              error and no warning. A protocol reporting utilisation as{" "}
              <Mono>85</Mono> meaning 85% is telling AutoShield 0.85%, and will
              never trip the threshold. Check your units against the table above
              before wiring anything up.
            </p>
          </Panel>

          <H>3. Your contract must not trust the guard</H>
          <P>
            This is why AutoShield is safe to put in front of a protocol at all.
            Re-validate everything it sends:
          </P>
          <Code>{`def apply_response(self, incident_id, level, deadline_ts, severity) -> str:
    self._only_guard()                      # 1. only the wired guard may call

    now_ts = _now_ts()
    if bool(self.applied_incidents.get(incident_id, False)):
        raise gl.vm.UserError("[EXPECTED] Incident already applied")   # 2. no replay
    if level not in ("PROTECT", "HALT"):
        raise gl.vm.UserError("[EXPECTED] Unknown response level")     # 3. closed set
    if int(deadline_ts) <= now_ts:
        raise gl.vm.UserError("[EXPECTED] Response already expired")

    # 4. a ceiling, not a rejection: too much is clamped, not refused
    effective_deadline = min(int(deadline_ts), now_ts + MAX_RESPONSE_TTL_SECONDS)`}</Code>
          <P>
            Copy this posture, not just the signature. A guard asking for a
            deadline a year out should get your maximum, not a year.
          </P>

          <H>4. The anti-brick rules worth keeping</H>
          <ul className="mb-4 space-y-2.5 text-[14.5px] leading-[1.7] text-[var(--color-ink-dim)]">
            {[
              "Every response carries an absolute deadline, and modes decay on their own with no transaction required. Nobody has to be online for recovery.",
              "HALT decays to RESTRICTED first, never straight to NORMAL.",
              "Repayment is never blocked, in any mode. A user who owes money can always get out. This is the single rule most worth keeping.",
              "A HALT chain is capped, so a stuck evaluator cannot ratchet you closed.",
            ].map((rule) => (
              <li key={rule} className="flex gap-2.5">
                <span aria-hidden="true" className="text-[var(--color-ok)]">
                  ✓
                </span>
                <span>{rule}</span>
              </li>
            ))}
          </ul>

          <H>5. Deploy your own</H>
          <P>
            AutoShield is deployed <strong className="font-semibold text-[var(--color-ink)]">per protocol</strong>.
            There is no shared service and you are not trusting us with
            anything: you deploy your own instance, you own it, and it guards
            only your contract.
          </P>
          <Code>{`AutoShield(protocol_address: Address, evaluator: Address)

shield.set_reporter(address, True)   # owner-only: who may file incidents
shield.set_evaluator(address)        # owner-only: who may adjudicate
protocol.set_initial_guard(shield_address)`}</Code>

          <H>What this does not do yet</H>
          <P>
            Honest limits. Finding these out in five minutes is better than
            after a week of work.
          </P>
          <ul className="mb-4 space-y-3 text-[14.5px] leading-[1.7] text-[var(--color-ink-dim)]">
            <li>
              <strong className="font-semibold text-[var(--color-ink)]">
                Your protocol must change its code.
              </strong>{" "}
              An already-deployed immutable contract cannot be guarded at all.
              This fits protocols being written now, proxy/upgradeable
              protocols, and those with a governance-controlled module system.
            </li>
            <li>
              <strong className="font-semibold text-[var(--color-ink)]">GenLayer only.</strong>{" "}
              AutoShield reaches your protocol through a GenLayer contract call.
              Cross-chain to EVM is unbuilt and untested.
            </li>
            <li>
              <strong className="font-semibold text-[var(--color-ink)]">
                Telemetry is self-reported.
              </strong>{" "}
              Reading your contract defends against a lying reporter. It does
              not defend against a protocol whose own accounting is already
              corrupted.
            </li>
            <li>
              <strong className="font-semibold text-[var(--color-ink)]">
                Three metrics are real work.
              </strong>{" "}
              The rolling windows behind <Mono>window_volume_bps</Mono>,{" "}
              <Mono>liquidity_delta_bps</Mono> and <Mono>top_sender_share_bps</Mono>{" "}
              are yours to implement. The demo protocol fills them from
              simulation variables.
            </li>
            <li>
              <strong className="font-semibold text-[var(--color-ink)]">No audit.</strong>{" "}
              This code has not been audited by anyone.
            </li>
          </ul>

          <Panel className="mt-8 p-5">
            <p className="text-[14px] leading-[1.7] text-[var(--color-ink-dim)]">
              The longer version of this page, with the full checklist, lives in{" "}
              <Mono>docs/INTEGRATION.md</Mono> in the repository, alongside both
              contracts and the test suites that cover them.
            </p>
          </Panel>
        </div>
      </main>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[var(--color-surface-2)] px-1 py-0.5 font-mono text-[12.5px] text-[var(--color-ink)]">
      {children}
    </code>
  );
}
