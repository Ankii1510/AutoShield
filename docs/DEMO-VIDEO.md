# Demo video script

Target length **3:00–3:30**. Everything below is real: no mockups, no cuts that
hide a failure, no claim the recording does not show on screen.

The whole video exists to land one idea:

> The LLM never chooses the response level. It returns a number and six
> booleans. Deterministic code decides SAFE / PROTECT / HALT.

Everything else — the console, the validators, the countdown — is evidence for
that sentence.

---

## Before you hit record

```bash
# 1. Both suites green, from a fresh node each time
cd <repo root>
./scripts/glsim.sh restart 5 && .venv/bin/python -m pytest tests/direct -q
./scripts/glsim.sh restart 5 && .venv/bin/python -m pytest tests/integration -q

# 2. The hosted console is on chain, not Demo mode (docs/DEPLOY-CONSOLE.md step 3)

# 3. Protocol is in NORMAL, so the HALT is visible when it happens
cd frontend
node scripts/demo-incident.mjs --network studio-next --scenario normal --no-execute
```

Have ready, in this order:

1. a terminal, font large enough to read at 1080p;
2. a browser on the hosted console;
3. a second tab on `contracts/autoshield.py` at `derive_level()`;
4. `TESTNET_PRIVATE_KEY` already exported in the terminal, and the terminal
   scrolled so it is off screen.

A real adjudication on Studio Next takes roughly **30–60 seconds**. Do not cut
it out — the wait is the product. Talk over it.

---

## Scene 1 — The problem (0:00–0:25)

**On screen:** the hosted console, protocol in NORMAL.

> "When a DeFi protocol gets exploited, the damage is done in minutes. The team
> finds out on Twitter. By the time a human can react, the money is gone.
>
> The obvious fix is to let an AI watch the protocol and hit the emergency
> brake. The obvious problem with that fix is that you have just given a
> language model the power to freeze a protocol — and models hallucinate.
>
> AutoShield is an answer to that second problem."

---

## Scene 2 — The core commitment (0:25–1:00)

**On screen:** switch to `contracts/autoshield.py`, `derive_level()` visible.

> "The evaluation runs under GenLayer validator consensus. But look at what it
> is allowed to return."

Scroll to the `run_nondet` block, point at the output shape.

> "A severity score, zero to one hundred. And six booleans. Seven fields. No
> prose, no recommendation, no action.
>
> Then this function — pure, deterministic, on chain — decides the response
> level."

Point at the HALT rule.

> "Severity alone is never enough to halt a protocol. A HALT needs a
> corroborating signal. If the model returns severity one hundred and cannot
> name a single observation to back it up, it gets the reversible response, not
> the freeze.
>
> And if the model returns a field called `level` saying HALT — that key is
> never read. Not filtered. Never read. The verdict is rebuilt from exactly
> those seven fields."

---

## Scene 3 — A real incident, live (1:00–2:10)

**On screen:** terminal, console visible beside it if your layout allows.

> "Let's run one for real, against contracts that are live on GenLayer Studio
> Next."

```bash
node scripts/demo-incident.mjs --network studio-next --scenario critical
```

Narrate as the steps print:

- **simulated observation** — "This part is simulated, and it's labelled. It
  moves the demo protocol's own reported telemetry. There is no exploit code in
  this repository."
- **incident created** — "That's a real transaction."
- **adjudicating** — "Now GenLayer validators are each running the evaluation
  independently. This takes about a minute."

While waiting:

> "This is the part a local simulator cannot show you. On a local node every
> validator gets the same canned answer, so they always agree — that tells you
> nothing. Here they each call a real model."

When it finalizes, read the output:

> "Severity eighty-two. Signals: price manipulation, liquidity drain. Level
> HALT — and notice that's read back **from the chain**, then cross-checked
> against the contract's own `preview_level` view. If those two ever disagreed,
> the run would stop rather than report a result."

**Cut to the console.** Reload. Protocol card is HALTED, countdown running.

---

## Scene 4 — The anti-brick guarantee (2:10–2:45)

**On screen:** the console, HALTED with the countdown visible.

> "So the protocol is halted. Which raises the obvious question — what if the AI
> was wrong?"

Point at the countdown.

> "Every response has an absolute deadline. It expires on its own, with nobody
> sending a transaction. A HALT doesn't jump back to normal either — it steps
> down through RESTRICTED first.
>
> Repayment is never blocked. In any mode. A user who owes money can always get
> out.
>
> And AutoShield has no method that can move value. It holds no funds. Its
> entire authority over the protected protocol is one queued call, whose
> arguments the protocol re-validates and clamps itself.
>
> A false positive costs you thirty minutes of restricted operation. It cannot
> brick the protocol."

---

## Scene 5 — Honest evidence (2:45–3:15)

**On screen:** the `INC-1` incident detail, showing the disagree votes.

> "One last thing, because it's the most interesting result we got."

Point at the vote tally.

> "This incident scored thirty-two — SAFE, no response. But look at the votes:
> three validators agreed with the leader and **two disagreed**. That's real
> non-deterministic variance, on a real network, and the transaction still
> finalized on the majority.
>
> We have observed that this happens. We have not characterised how often — that
> needs a run at size, and until we do it, our severity tolerance stays
> uncalibrated at plus or minus fifteen. It says so in the README."

---

## Scene 6 — Close (3:15–3:30)

**On screen:** the hosted console.

> "AutoShield. The model contributes judgment. Deterministic code keeps
> authority. Live on Studio Next — addresses and every transaction hash are in
> the repo."

---

## Rules while recording

- **Never show a private key**, a keystore password, or a terminal scrollback
  containing either. Clear the terminal before recording.
- **Do not cut the adjudication wait** to make it look faster than it is.
- **If a run fails on camera, keep it and say what happened.** A real network
  failing occasionally is more credible than a demo that never does. If you must
  re-record, re-record the whole scene, not a patch.
- **Never say "consensus verified" over the local simulator.** With mocked
  evaluation, unanimity is guaranteed by construction. Only the Studio Next runs
  are evidence about consensus.
- **Do not claim the wallet button works** unless you have verified it (see
  `docs/DEPLOY-CONSOLE.md` step 4). The command-line flow is the demo; the
  console is the window onto it.

## If something breaks mid-record

| Problem | What to do |
|---|---|
| Adjudication returns a different severity | Fine — say the number you see. Variance is the point. |
| Level comes back PROTECT instead of HALT | Also fine, and it's the safety property: the model didn't corroborate. Say so. |
| Transaction fails | Say what the network reported and re-run. Do not present a failed run as a success. |
| Console shows "Simulated — no chain" | Stop. The hosting env vars are wrong — see `docs/DEPLOY-CONSOLE.md` step 3. |
| Reporter cooldown blocks a second run | Wait it out on camera or cut to the next scene. The script waits rather than bypassing it. |
