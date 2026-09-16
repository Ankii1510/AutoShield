# Integrating AutoShield into your protocol

This is what a protocol team needs in order to put AutoShield in front of their
own contract. It is written from the contracts, not from intent: every name,
signature and threshold below is what `contracts/autoshield.py` actually reads
and sends today.

Read [the limits](#what-this-does-not-do-yet) first. They decide whether
AutoShield is usable for you at all, and it is better to find that out in five
minutes than after a week of work.

---

## The whole integration surface

Two methods on your contract, and one wiring call. That is the entire surface.

```python
@gl.public.view
def telemetry(self) -> dict: ...

@gl.public.write
def apply_response(
    self, incident_id: str, level: str, deadline_ts: u256, severity: u256
) -> str: ...
```

AutoShield holds **one** authority over your protocol: a single queued call to
`apply_response`. It has no method that can move value, change your oracle,
change your owner, or halt you indefinitely — not because it promises not to,
but because no such code path exists. `contracts/autoshield.py` implements no
transfer of any kind and is not payable anywhere.

Everything else in this document is detail on those two methods.

---

## 1. `telemetry()` — what AutoShield reads

AutoShield calls this **directly on your contract** before every adjudication.
It does not trust the reporter's copy of your metrics; the gap between what a
reporter claims and what your contract reports is itself an input to the
evaluation (`evidence_inconsistent`).

Return a flat dict of **integers**. GenLayer calldata has no float type — a
fractional value raises at the VM boundary before your code is reached.

### Required keys

These five are compared against thresholds and shown to the evaluator. All are
**basis points** (1% = 100 bps, 100% = 10000 bps):

| Key | Meaning | Threshold AutoShield flags at |
|---|---|---|
| `deviation_bps` | oracle price vs. your baseline | 1500 (15%) |
| `utilisation_bps` | borrowed ÷ deposits | 9000 (90%) |
| `window_volume_bps` | borrow volume in a recent window, against your own normal | 5000 (50%) |
| `liquidity_delta_bps` | drop in available liquidity over a recent window | 3000 (30%) |
| `top_sender_share_bps` | share of recent activity from the single busiest sender | 8000 (80%) |

Also read, and worth getting right:

| Key | Meaning |
|---|---|
| `mode` | your current operating mode as a string |
| `total_deposits_atto` | total deposited, in atto units |
| `total_borrowed_atto` | total borrowed, in atto units |
| `seconds_since_update` | age of your oracle price |

### The unit trap, stated plainly

AutoShield reads every metric with `observed.get(name, 0)`. **A key you do not
return is read as zero**, which looks exactly like "nothing anomalous". There is
no error, no warning, and nothing in the console will tell you. A protocol that
reports utilisation as `85` meaning 85% is telling AutoShield `85` bps — 0.85% —
and will never trip the utilisation threshold.

Check your units against the table above before you wire anything up.

### Example

```python
@gl.public.view
def telemetry(self) -> dict:
    now_ts = _now_ts()
    price = int(self.oracle_price_atto)
    baseline = int(self.baseline_price_atto)

    deviation_bps = 0
    if baseline > 0:
        diff = price - baseline if price > baseline else baseline - price
        deviation_bps = diff * 10_000 // baseline

    deposits = int(self.total_deposits_atto)
    borrowed = int(self.total_borrowed_atto)
    utilisation_bps = borrowed * 10_000 // deposits if deposits > 0 else 0

    return {
        "deviation_bps": deviation_bps,
        "utilisation_bps": utilisation_bps,
        "window_volume_bps": self._borrow_volume_bps(),      # you implement
        "liquidity_delta_bps": self._liquidity_delta_bps(),  # you implement
        "top_sender_share_bps": self._sender_concentration_bps(),  # you implement
        "mode": self._effective_mode(now_ts),
        "total_deposits_atto": deposits,
        "total_borrowed_atto": borrowed,
        "seconds_since_update": max(0, now_ts - int(self.oracle_updated_ts)),
        "now_ts": now_ts,
    }
```

**The three `self._*_bps()` calls are the real work, and this repository does not
do it for you.** `contracts/demo_lending.py` fills those three fields from
`sim_*` storage variables that its owner-only `simulate_*` methods set — they
exist so the demo has something to judge. A production protocol has to actually
track a rolling window of borrow volume, liquidity change and sender
concentration. That is the largest piece of work in adopting AutoShield, and
pretending otherwise would waste your time.

---

## 2. `apply_response()` — what AutoShield sends

```python
apply_response(incident_id: str, level: str, deadline_ts: u256, severity: u256) -> str
```

- `level` is `"PROTECT"` or `"HALT"`. **Never `"SAFE"`** — a SAFE verdict
  dismisses the incident and sends nothing.
- `deadline_ts` is a unix second. AutoShield asks for now + 3600 for PROTECT,
  now + 1800 for HALT.
- `severity` is 0–100, for your records and events.
- Return the level you **actually** applied, which may be lower than the one
  requested.

### Your contract must not trust the guard

This is the part that matters, and it is why AutoShield is safe to put in front
of a protocol at all. `apply_response` re-validates everything:

```python
@gl.public.write
def apply_response(self, incident_id, level, deadline_ts, severity) -> str:
    self._only_guard()                      # 1. only the wired guard may call

    now_ts = _now_ts()
    if incident_id == "":
        raise gl.vm.UserError("[EXPECTED] Incident id required")
    if bool(self.applied_incidents.get(incident_id, False)):
        raise gl.vm.UserError("[EXPECTED] Incident already applied")   # 2. no replay
    if level not in ("PROTECT", "HALT"):
        raise gl.vm.UserError("[EXPECTED] Unknown response level")     # 3. closed set
    if int(severity) < 0 or int(severity) > 100:
        raise gl.vm.UserError("[EXPECTED] Severity out of range")

    if int(deadline_ts) <= now_ts:
        raise gl.vm.UserError("[EXPECTED] Response already expired")
    # 4. a ceiling, not a rejection: too much is clamped, not refused
    effective_deadline = min(int(deadline_ts), now_ts + MAX_RESPONSE_TTL_SECONDS)
    ...
```

Copy this posture, not just the signature. A guard that asks for a deadline a
year out should get your maximum, not a year. A guard that names a level you do
not implement should be refused, not guessed at.

### The anti-brick rules you should keep

A false positive must not be able to disable your protocol. In
`demo_lending.py` that means, and you should match:

- **Every response has an absolute deadline**, and modes decay on their own with
  no transaction required. Nobody has to be online for recovery to happen.
- **HALT decays to RESTRICTED first**, not straight to NORMAL.
- **Repayment is never blocked, in any mode.** A user who owes money can always
  get out. This is the single rule most worth keeping.
- **A HALT chain is capped.** After `MAX_CONSECUTIVE_HALTS` the response is
  downgraded rather than escalated, so a stuck evaluator cannot ratchet you
  closed.

---

## 3. Wiring

```python
@gl.public.write
def set_initial_guard(self, guard: Address) -> None:
    """One-shot genesis wiring. Refuses to act once a guard exists."""
    self._only_owner()
    if self.guard_initialized:
        raise gl.vm.UserError("[EXPECTED] Guard already initialized")
    if guard == Address(bytes(20)):
        raise gl.vm.UserError("[EXPECTED] Guard cannot be zero address")
    self.guard_address = guard
    self.guard_initialized = True
```

Rotation after genesis should be **timelocked** (propose, then confirm after a
delay), so that a compromised owner key cannot instantly repoint your guard at
an attacker's contract. See `propose_guard` / `confirm_guard` in
`demo_lending.py`.

---

## 4. Deploy your own AutoShield

**AutoShield is deployed per protocol. There is no shared service, and you are
not trusting us with anything.** You deploy your own instance, you own it, and
it guards only your contract.

```python
AutoShield(protocol_address: Address, evaluator: Address)
```

The deployer becomes the owner. Then:

```
shield.set_reporter(address, True)   # owner-only; who may file incidents
shield.set_evaluator(address)        # owner-only; who may run adjudication
protocol.set_initial_guard(shield_address)
```

`frontend/scripts/deploy-testnet.mjs` does this whole sequence and then verifies
the wiring by reading it back off the chain. Point it at your contracts.

### Why reporting is allowlisted

An open reporting endpoint is a free denial-of-service surface: anyone could
file incidents until your open slots filled. Reporters are allowlisted, there is
a per-reporter cooldown, and there are caps on open incidents and on reports per
window.

Two actions are deliberately **permissionless** — executing an adjudicated
response, and expiring a stale incident. Both only ever move the system toward
safety or recovery, so neither may depend on one key being online.

---

## 5. Who runs what

| Role | Who | What they need |
|---|---|---|
| Owner | your deployer key | sets reporters and evaluator, can clear a false positive early |
| Evaluator | a backend account you run | calls `adjudicate()` |
| Reporter | your monitoring service | calls `report_incident()` with evidence |
| Anyone | anyone | can execute an adjudicated response, or expire a stale incident |
| Your end users | — | **nothing.** They never touch AutoShield. |

That last row is worth saying out loud: the people who benefit most from
AutoShield never see it. The console is an operator tool for your team.

**In production, the thing that files an incident is a monitoring service, not a
person.** This repository does not ship one. `frontend/scripts/demo-incident.mjs`
drives the same flow from the command line and is the closest thing to a
reference; turning it into a service that watches your telemetry and files on a
threshold is work you would have to do.

---

## What this does not do yet

Honest limits. None of these are hidden in the code.

**Your protocol must change its code.** `telemetry()` and `apply_response()`
have to exist on the protected contract. An already-deployed immutable contract
cannot be guarded by AutoShield at all. This fits protocols being written now,
proxy/upgradeable protocols, and protocols with a governance-controlled module
system. It does not fit an immutable contract that is already live.

**GenLayer only.** AutoShield reaches your protocol through
`gl.contract.get_at`, which addresses GenLayer contracts. Most DeFi TVL is on
Ethereum and its L2s. The GenLayer SDK ships a `gl.evm` module for EVM contract
interfaces, which is the obvious direction — but AutoShield uses none of it and
that path has not been tested here. Treat cross-chain as unbuilt.

**Telemetry is self-reported.** AutoShield reads your contract rather than a
reporter's claims, which defends against a lying reporter. It does not defend
against a protocol whose own accounting has already been corrupted. If an
attacker controls your state, they control what AutoShield sees.

**The evaluator is a single address.** Adjudication runs under GenLayer
validator consensus, so the *verdict* is not one party's opinion — but *who may
trigger* an adjudication is one key today. There is no multi-evaluator or
rotation scheme.

**`SEVERITY_TOLERANCE` is ±15 and uncalibrated.** It is the width within which
two validators' severities are allowed to differ. It has never been changed and
must only ever change from measured live data, never to make a run agree.

**No audit.** This code has not been audited by anyone.

---

## Checklist

1. Decide whether your contract can change at all. If not, stop here.
2. Implement `telemetry()`. Check every unit against the threshold table.
3. Implement the three rolling-window metrics. This is the real work.
4. Implement `apply_response()` with your own bounds, and keep the anti-brick
   rules.
5. Add `set_initial_guard`, with a timelocked rotation path.
6. Deploy your own AutoShield with your protocol's address.
7. Wire guard, reporter and evaluator; verify by reading it back.
8. Run `demo-incident.mjs` against your deployment and watch what happens.
9. Build the monitoring service that files incidents for real.

Steps 3 and 9 are where the time goes. Everything else is an afternoon.
