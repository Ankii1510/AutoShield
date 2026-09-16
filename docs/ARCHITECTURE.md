# AutoShield — Architecture

Autonomous emergency response for smart contracts, built on GenLayer.

This document covers the **blockchain foundation** (Phase 2) and the **GenLayer
adjudication engine** (Phase 3): two intelligent contracts, the response state machine,
the authority boundaries, the anti-brick mechanism, and the non-deterministic evaluation
that now runs under validator consensus.

---

## 1. Contract responsibilities

### `contracts/demo_lending.py` — `DemoLendingProtocol`

The protocol being protected. **100% deterministic**: no `gl.nondet.*` call of any kind.

- Runs a controlled demo lending market — supply, borrow, repay, withdraw — against a
  mock oracle, in internal accounting units (atto-scale integers, no native value).
- Publishes `telemetry()`: the authoritative, live metrics AutoShield reads.
- Enters simulated suspicious states on owner command, for the demo.
- **Defends itself.** It enforces guard authorization, incident replay protection, the
  maximum response TTL, the escalation ceiling, and automatic mode decay *independently
  of AutoShield*.

It contains no exploit code, no attack primitives, and touches no external protocol. The
`simulate_*` methods are a telemetry overlay: apart from the oracle price (a legitimate
protocol parameter) they never mutate real accounting, and `conservation_check()` holds
before and after every one of them.

### `contracts/autoshield.py` — `AutoShield`

The incident controller, registry and adjudicator.

- Intake: reporter authorization, category and evidence validation, freshness,
  deduplication, cooldowns, open-incident cap, global rate window.
- Registry: one compact `Incident` record per report.
- **Adjudication: `adjudicate()` evaluates the incident under GenLayer validator
  consensus via `gl.vm.run_nondet(...)`.**
- Policy: `derive_level(severity, signals) -> SAFE | PROTECT | HALT`.
- Execution: one queued call to the protocol's `apply_response`.
- Reads the protocol's live telemetry via a synchronous cross-contract view — outside
  the nondet block, because cross-contract calls are forbidden inside one.

Phase 3 **replaced** Phase 2's `record_evaluation(incident_id, severity, signals_bits)`.
Leaving it in place would have been a standing bypass of consensus: a privileged
evaluator could have injected severity 100 with corroborating signals directly. The
deterministic handling below the evaluation is byte-for-byte the same code it was.

---

## 2. Why GenLayer is used only for non-deterministic evidence evaluation

Almost everything AutoShield does is ordinary deterministic logic that any chain could
run: who may report, is the evidence fresh, is this a duplicate, what happens as a
result, when does it expire. Putting that on an LLM would add cost, latency and variance
while removing auditability. It stays deterministic.

Exactly one question resists deterministic treatment:

> Given this protocol's live telemetry, the reporter's claimed observation, and the
> pre-computed threshold comparisons — **how strongly does the evidence indicate an
> active exploit, and which named signals are present?**

A 41% oracle move is an exploit signature in one context and a legitimate market crash in
another. Telling them apart means reading the shape of the activity together with the
narrative, and it genuinely benefits from independent re-evaluation by multiple
validators that must then agree. That is what GenLayer consensus is for, and it is the
only part of the system that will use it.

**The critical constraint: the model never chooses the response level.**

The non-deterministic block returns only:

- a **severity score** in `[0, 100]`, and
- a **closed set of boolean signal flags**.

`derive_level()` — a pure function, identical on every validator, exhaustively unit
tested — maps those to `SAFE`, `PROTECT` or `HALT`. This buys three things at once:

1. **Safety.** The consequential decision lives in auditable code, not in a prompt.
2. **Consensus stability.** Validators must agree on a number within a tolerance and a
   handful of booleans, not on a categorical label whose boundary they may straddle.
3. **Separability.** The response policy can change without touching the prompt, and the
   prompt can change without touching the policy.

## 2a. The adjudication engine

**GenLayer APIs used** (all verified against the installed SDK, not copied from docs):

| API | Use |
|---|---|
| `gl.vm.run_nondet(leader_fn, validator_fn)` | consensus wrapper — sandboxes the validator, unlike `run_nondet_unsafe` |
| `gl.nondet.exec_prompt(prompt, response_format="json")` | the evaluation itself |
| `gl.vm.Return` / `gl.vm.UserError` / `gl.vm.Result` | leader-result discrimination |
| `gl.get_contract_at(addr).view().telemetry()` | observed telemetry, read **before** the nondet block |

Deviations from the genlayer-dev skill's examples, all verified in the SDK source:

- the skill's skeleton uses `gl.message.sender_account`, which does not exist —
  `MessageType` exposes `sender_address`;
- `gl.eq_principle.prompt_comparative` / `prompt_non_comparative` exist but are not used:
  the first sends both answers to an LLM to judge similarity, which is weaker and less
  predictable than comparing a bounded integer and six booleans in code;
- cross-contract calls are **forbidden** inside a nondet block (GenVM raises
  `SystemError: 6`), so telemetry is read first and passed in as plain data;
- GenLayer calldata has **no float type** (`calldata.encode(1.5)` raises), so a
  fractional number in model output fails at the VM boundary before parsing.

**Exact output schema** — seven keys, nothing else:

```json
{"severity": 0-100,
 "price_manipulation": bool, "liquidity_drain": bool, "borrow_anomaly": bool,
 "coordinated_activity": bool, "evidence_inconsistent": bool, "condition_resolved": bool}
```

**Consensus.** The validator does not inspect the leader's answer for well-formedness —
that would prove only that the leader formatted its answer correctly. It **re-runs the
same evaluation independently**, then `_compare_verdicts` requires all three of:

1. every boolean matches **exactly** — the flags gate HALT, so no tolerance;
2. severities within **±15** — severity is ordinal, and demanding exact agreement would
   fail consensus constantly;
3. `derive_level` lands on the **same level** for both — the binding condition. Two
   severities inside the tolerance that straddle a threshold (74 vs 75) are a
   disagreement, because agreeing on the consequence is what matters.

Stability comes from the prompt carrying **pre-computed threshold comparisons as ground
truth** rather than asking the model to do arithmetic, and from the canonical value being
a small fixed record — **no free-form prose is part of the consensus value**.

**Malformed output** is rejected, never guessed at. `_parse_verdict` raises `[LLM_ERROR]`
on a non-object, a missing signal, a missing or non-integer severity, a severity outside
0–100, or a signal that is not a boolean (`0`/`1` and the exact strings `"true"`/`"false"`
are normalised; `"yes"`, `2` and `None` are not). LLM-class errors always make the
validator **disagree**, which rotates consensus instead of freezing a broken verdict into
state. Because the rejection writes nothing, the incident stays `READY` and a retry
works.

**Prompt injection.** `metadata_json`, `evidence_uri` and `category` are
reporter-controlled and reach a language model. `_sanitize_untrusted` flattens control
characters and newlines, collapses whitespace, caps length, and strips the fence markers
and code fences, so a reporter cannot close the data block and start issuing
instructions; the fields are then wrapped in labelled `<<<UNTRUSTED … UNTRUSTED>>>`
blocks with an explicit instruction that their contents are data. This does not make
injection impossible — no escaping stops text from *reading* as instructions — but the
blast radius is bounded by the architecture: a fully successful injection can only set a
severity and six booleans, `derive_level` still decides, and the protocol still clamps.

---

## 3. Response levels

| | **SAFE** | **PROTECT** | **HALT** |
|---|---|---|---|
| Severity band | 0 – 39 | 40 – 74 | 75 – 100 **and** ≥1 decisive signal **and** no `evidence_inconsistent` |
| Protocol mode | NORMAL (unchanged) | RESTRICTED | HALTED |
| New borrows | allowed | **blocked** | **blocked** |
| New supply | allowed | allowed | blocked |
| Withdrawals | allowed | capped at 20% of position per incident | blocked |
| **Repayments** | **allowed** | **allowed** | **allowed** |
| TTL requested | n/a | 3600 s | 1800 s |
| On expiry | n/a | → NORMAL | → **RESTRICTED**, then → NORMAL |
| Owner override | n/a | immediate | immediate |
| Moves value | never | never | never |

`condition_resolved` forces SAFE at any severity: if the situation has already passed,
acting is pure false-positive cost.

---

## 4. State machines

### Protocol mode

```
                apply_response(PROTECT)
        ┌──────────────────────────────────────┐
        │                                      ▼
   ┌─────────┐  apply_response(HALT)     ┌────────────┐
   │ NORMAL  │ ───────────────────────▶  │   HALTED   │
   └─────────┘                           └────────────┘
        ▲                                      │
        │                                      │ deadline passes
        │                                      ▼
        │                              ┌────────────────┐
        └───────────────────────────── │   RESTRICTED   │
           deadline passes             └────────────────┘
                                               │ ▲
                                               │ │ apply_response(HALT)
                                               ▼ │   (escalation)
                                            ┌────────────┐
                                            │   HALTED   │
                                            └────────────┘
```

Decay is **lazy**: `_compute_mode(now)` derives the mode in force on every read, and
`_settle_mode(now)` commits it on the next gated write. No transaction from anyone is
required for the protocol to recover.

Invalid transitions are unrepresentable: `apply_response` accepts only `PROTECT` and
`HALT`, rejects unknown levels, empty incident ids, out-of-range severities, past
deadlines and replayed incidents, and clamps everything else.

### Incident lifecycle

```
                    report_incident()
                          │
                          ▼
                      [ READY ]
                          │
            record_evaluation()
          ┌───────────────┴──────────────┐
          │ level == SAFE                │ level != SAFE
          ▼                              ▼
   [ DISMISSED ]                   [ EVALUATED ]
                                         │
                       execute_response() │
                          ┌──────────────┴─────────────┐
                          ▼                            ▼
                    [ APPLIED ]                   (window or
                                                   deadline lapses)
                                                        │
                                                        ▼
   [ READY ] ──(evaluation window lapses)──────────▶ [ STALE ]
```

`DISMISSED`, `APPLIED` and `STALE` are terminal; there is no path back to an active
status without a new incident carrying new evidence.

A rejected call **writes nothing**. A reverting transaction rolls back every write it
made, so the contracts never "mark stale, then raise" — that would be a silent no-op
on-chain. The permissionless `expire_incident` performs the transition in a transaction
that actually commits.

---

## 5. Authority boundaries

```
 owner (protocol)          guard = AutoShield             reporter / anyone
 ────────────────          ──────────────────             ─────────────────
 mint demo balance         apply_response  ◀── the ONLY   report_incident
 set oracle price            (PROTECT|HALT,     authority  execute_response
 set baseline                 bounded deadline)            expire_incident
 clear_response            …and nothing else               deposit/withdraw
 simulate_*                                                borrow/repay
 propose/accept guard
```

**AutoShield cannot move value.** It holds none, no method is payable, `__receive__` is
deliberately not implemented, and its entire ABI is asserted by a test
(`test_shield_abi_exposes_no_value_moving_method`) so that adding such a method breaks
the build rather than silently voiding this claim.

**The protocol does not trust the guard.** `apply_response` re-validates every argument
it is handed: unknown levels are rejected, replayed incident ids are rejected, past
deadlines are rejected, excessive deadlines are clamped to `MAX_RESPONSE_TTL_SECONDS`,
and halts beyond `MAX_CONSECUTIVE_HALTS` are downgraded to PROTECT.

**Guard rotation is timelocked** (24 h propose → accept), with a one-shot
`set_initial_guard` for genesis wiring.

The blast radius of a fully compromised AutoShield is therefore: at most
`MAX_RESPONSE_TTL_SECONDS` of degraded service, with repayment open throughout and every
balance untouched.

---

## 6. The anti-brick mechanism

Five independent guarantees, each enforced by `DemoLendingProtocol` itself:

1. **Every response carries an absolute deadline**, stored as a unix second — never a
   duration, which a delayed message could silently extend.
2. **Modes decay lazily.** `_compute_mode()` runs on every read and before every gated
   write. Recovery needs no keeper, no owner action, and no cooperation from AutoShield.
3. **HALT decays to RESTRICTED, not to NORMAL.** A genuine ongoing exploit still faces a
   borrow freeze after the halt lapses; a false positive costs at most 30 minutes of full
   freeze.
4. **Repayment is never blocked**, in any mode. There is deliberately no
   `_require_can_repay`. A borrower can always reduce their own risk, including during a
   false-positive halt — this is what stops a bad call turning into liquidation damage.
5. **Escalation is capped.** After `MAX_CONSECUTIVE_HALTS` halts without the protocol
   returning to NORMAL, further HALT requests are downgraded to PROTECT. No sequence of
   AutoShield actions can chain halts indefinitely.

Plus the owner's immediate `clear_response()` override.

---

## 7. Evidence model

Bulk evidence never goes on-chain. Each incident stores a hash, a bounded pointer, and
compact metadata:

| Field | Purpose |
|---|---|
| `evidence_hash` | Keccak/SHA digest of the off-chain bundle (≤ 66 chars) |
| `evidence_uri` | Pointer for human audit (≤ 256 chars) — **never fetched on-chain** |
| `metadata_json` | Compact claimed metrics (≤ 512 chars) |
| `observed_at_ts` | Reporter's claim, must be within 600 s of transaction time |
| `created_at_ts` | Transaction time at intake |

`evidence_uri` is deliberately never fetched during evaluation: fetching a
reporter-supplied URL would be both an SSRF vector and a consensus hazard, since the
content could differ between leader and validator.

The trust model has three layers:

| Layer | Source | Trust |
|---|---|---|
| **Claimed** | `metadata_json` | untrusted — an assertion, to be scored |
| **Observed** | `protocol.view().telemetry()` | authoritative |
| **Derived** | divergence between them | the anti-manipulation signal |

Deduplication keys on `Keccak256(protocol │ category │ evidence_hash │ time_bucket)`, so
nudging a timestamp does not mint a fresh incident.

---

## 8. Time

GenVM exposes **no block timestamp**. The only clock available to a contract is
`gl.message_raw['datetime']`, an ISO-8601 string carrying the transaction datetime. Both
contracts parse it into unix seconds with integer arithmetic only — no float, which is
software-emulated in deterministic blocks and a consensus hazard in non-deterministic
ones. Every deadline is absolute.

---

## 9. Security properties and where they are enforced

| Threat | Mitigation | Location |
|---|---|---|
| Unauthorized callers | `_only_owner` / `_only_guard` / `_only_evaluator`; reporter allowlist | both |
| Duplicate incident ids | monotonic ids + existence assertion + `dedup_index` fingerprint | AutoShield |
| Replayed responses | `applied_incidents` map, permanent — outlives the response | protocol |
| Stale evidence | `observed_at` within freshness window; future-dating rejected | AutoShield |
| Stale responses | evaluation and execution windows; past deadlines rejected on both sides | both |
| Expired responses | absolute deadlines + lazy decay | protocol |
| Unauthorized protocol control | single guard address; timelocked rotation; clamped arguments | protocol |
| Response spam | allowlist, per-reporter cooldown, open-incident cap, global rate window — all checked before any expensive work | AutoShield |
| Unsafe transitions | closed level set; closed signal set; totally-ordered lifecycle | both |
| Unsafe automatic actions | three restrictive-only levels; no value transfer anywhere | architecture |
| False positives | the five anti-brick guarantees above | protocol |

Anti-spam here is deliberately **non-monetary**. A bond would require AutoShield to
custody value, which is exactly the power the design denies it.

---

## 10. Testing

235 direct-mode tests and 38 integration tests, all passing, plus clean
`genvm-lint check` and `typecheck` on both contracts.

| File | Covers |
|---|---|
| `test_policy_engine.py` | `derive_level` boundaries; all 64 signal combinations × 6 severities; closed-set enforcement |
| `test_demo_lending.py` | supply, withdraw, borrow, repay, collateral and liquidity limits, oracle, simulation surface, conservation |
| `test_response_modes.py` | every valid and invalid transition, lazy decay, deadline clamping, escalation ceiling, repayment in **all three** modes |
| `test_protocol_security.py` | guard authorization, timelocked rotation, replay, "AutoShield cannot move funds" |
| `test_incident_registry.py` | intake validation, freshness, dedup, cooldown, caps, rate window |
| `test_lifecycle.py` | evaluation, execution, staleness, the emitted wire message, the full ABI assertion |
| `test_wire_contract.py` | both sides of the async seam agree on argument order, types and bounds |
| `test_adjudication.py` | all 14 required adjudication scenarios: severity bands, corroboration, malformed output, non-boolean signals, out-of-range severity, response-level injection, prompt injection |
| `test_adjudication_consensus.py` | `_compare_verdicts` as a pure function; the contract's real `validator_fn` replayed via `direct_vm.run_validator(...)`; the error-classification ladder; closure picklability |

Three documented gltest 0.29.2 limitations are worked around in `tests/direct/conftest.py`
— the contracts use production APIs unchanged:

1. `direct_vm.warp()` does not reach `gl.message_raw['datetime']`.
2. The SDK's one-contract-per-process global persists across tests.
3. All contracts share one storage root, so two cannot live in one VM — hence the
   `protocol_bridge` stand-in and the paired `test_wire_contract.py` assertions.

True end-to-end delivery of the asynchronous `emit` hop is an integration-test concern
(GLSim / Studio) and is not claimed to be covered by direct mode.

**What direct mode does not prove about consensus.** gltest patches `gl.vm.run_nondet` to
run `leader_fn()` only, recording `(result, leader_fn, validator_fn)`. Tests therefore
exercise the leader path, every deterministic step after it, and — via
`direct_vm.run_validator(leader_result=...)` — the contract's real validator function
against chosen leader results. They do **not** exercise multiple independent validators,
real LLM variance, vote tallying, or rotation on disagreement. Those belong to the
GenLayer consensus layer and can only be observed against GLSim, a local Studio, or a
testnet. `SEVERITY_TOLERANCE` should be tuned against measured integration data rather
than kept at its current reasoned default of 15.

---

## 10a. Consensus Verification

Three layers of assurance, deliberately not conflated.

### What direct mode proves (`tests/direct`, 235 tests)

gltest patches `gl.vm.run_nondet` to run `leader_fn()` only, recording
`(result, leader_fn, validator_fn)`. These tests prove the leader path, the
verdict parser, the policy engine, every deterministic state transition, and --
via `direct_vm.run_validator(leader_result=...)` -- the contract's real
`validator_fn` judged against chosen leader results, including the
disagreement cases that cannot be induced anywhere else.

They do **not** prove that consensus ran. Every contract also shares one storage
root there, so the two contracts cannot coexist and the cross-contract hop is
asserted at the wire level only.

### What integration mode proves (`tests/integration`, 38 tests, GLSim)

A real local GenLayer network: JSON-RPC transaction submission, a leader, **five
validators each executing the contract's own `validator_fn`**, majority voting,
leader rotation on disagreement, finalisation, and state read back from
contracts deployed at distinct addresses with separate storage. Asynchronous
`emit` messages are really delivered, so `apply_response` arriving at the
protected protocol is observed rather than inferred. With the node's clock
control, deadline decay (HALT -> RESTRICTED -> NORMAL), freshness and expiry are
exercised end to end.

It proves that the validator path **executes and votes**, and that the safety
boundary holds against a live network: severity 100 without corroboration
finalises as PROTECT, an injected `"level": "HALT"` is ignored, and malformed
evaluator output fails the transaction without applying any response.

It does **not** prove convergence. Without a live LLM provider every validator
receives the same canned answer through the supported `sim_installMocks` RPC, so
unanimity is guaranteed by construction. Agreement here is evidence of
execution, not of independently sampled answers agreeing.

### What testnet (or live-LLM) execution would prove

Independent model sampling per validator, and therefore: real severity variance,
whether `SEVERITY_TOLERANCE` of +/-15 is calibrated, genuine disagreement,
leader rotation triggered by that disagreement, and appeal economics.

`tests/integration/test_consensus_and_safety.py` already contains the variance
measurement; it skips unless `AUTOSHIELD_LLM_PROVIDER` and the matching API key
are set. **The tolerance has not been changed**, because no evidence exists yet
to change it with. It must be calibrated from measurement, never widened to make
a test pass.

### Current limitation, stated plainly

**Multi-validator agreement has been executed; multi-validator *convergence* has
not been observed.** No claim of "consensus verified" is made beyond that.

### Environment quirks found while building this

All reproduced against `genlayer-test[sim]==0.29.2`; the contracts are unmodified
apart from the ASCII constraint, which is a real source-level requirement.

| # | Finding | Handling |
|---|---|---|
| 1 | Contract source must be **pure ASCII** -- `genlayer_py` hex-encodes it via `eth_utils.encode_hex`, which does `value.encode("ascii")`; one em dash breaks schema retrieval | both contracts converted to ASCII |
| 2 | `Address` arguments die at glsim's decode -> re-encode boundary (`not calldata encodable addr#...: CalldataAddress`) | value-preserving shim in `scripts/glsim_node.py` |
| 3 | `sim_increaseTime` never reached the contract clock (measured: 0s for a 10000s increase), because `VMContext.warp` does not write `gl.message_raw['datetime']` | clock shim in `scripts/glsim_node.py`, guarded by an assertion in `test_environment.py` |
| 4 | `gen_getContractSchemaForCode` and deployment share one class cache and poison each other | ABI taken from `genvm-lint schema --json` instead |
| 5 | glsim's default chain id (61127) differs from `genlayer_py.chains.localnet` (61999) | `scripts/glsim.sh` sets `--chain-id 61999` |
| 6 | `sim_createSnapshot` records only key sets, not storage values, so restore does not roll back contract state | per-test isolation uses the contracts' own `expire_incident` / `clear_response` |
| 7 | `sim_installMocks` appends to the live mock list while first-match wins, so a stale mock shadows the new one | one throwaway read between install and use collapses the list |
| 8 | One deploy per contract per glsim process (the SDK allows one Contract subclass per process) | session-scoped deployment; `scripts/glsim.sh restart` before each run |

---

## 11. What Phase 5 will add

Deployment scripts and the operator frontend. The contracts and their test coverage are
complete for the demo.
