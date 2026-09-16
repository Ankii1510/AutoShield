# AutoShield — Progress & Handover

**Last updated:** 2026-09-15, Phase 8 — **FULLY MIGRATED TO CONSENSUS v0.6.**
One generation everywhere: contracts, local test stack, and the deployed target.

## LIVE DEPLOYMENT (chain 61997, consensus v0.6)

    DemoLendingProtocol  0x054be2be73d15DB1B13d836F4045612AB65c685A
    AutoShield           0x7834967C394e6831c34710134afc0BfFFD9eeA8E
    runner               py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng
    deployer/operator    0x83d074B194aa2AD828729F20b3988ac70e73161f
    deployed             2026-09-15T14:48Z  (deployments/studio-next.json)

Redeployed in Phase 8 from the v0.6-only source. The Phase 7 addresses
(0xdBd3.../0xb92D...) were the dual-shim build and are superseded.

**Two full incidents ran end to end against real validators and a real model:**

    INC-2  critical scenario   severity 82   price_manipulation, liquidity_drain
           -> HALT (read from chain; preview_level agreed), protocol HALTED,
              repayment still enabled, votes {"agree": 3, "idle": 2}

    INC-1  oracle scenario     severity 32   no signals
           -> SAFE, no response applied, votes {"agree": 3, "disagree": 2}

The second run is the more interesting one: **two validators genuinely
disagreed** with the leader and the transaction still finalized on the majority.
That is real non-deterministic variance under real consensus — something no
mocked local run has ever been able to show, since every validator there
receives the same canned answer. Mocked runs always returned severity 88; these
returned 82 and 32.

## TEST SUITES — GREEN ON v0.6

    tests/direct        234 passed, 1 skipped
    tests/integration    38 passed, 1 skipped   (GLSim, 5 validators)
    frontend             75 passed, 5 skipped;  tsc clean, eslint clean
    genvm-lint check     both contracts: lint + validation pass

Run the two Python suites SEPARATELY, each against a freshly restarted node:

    scripts/glsim.sh restart 5
    .venv/bin/python -m pytest tests/direct
    scripts/glsim.sh restart 5
    .venv/bin/python -m pytest tests/integration

GLSim executes every contract in one Python process and the GenLayer SDK allows
one Contract subclass per process, so a reused node fails the *next* session's
deploy with "not calldata encodable ... CalldataAddress". Running both suites in
a single pytest process fails 3 direct tests for the same reason. This is a
harness constraint, not a contract defect.

## WHAT PHASE 8 CHANGED

**Contracts — v0.6 only, no dual-generation shims.** Both files now pin the
v0.6 runner directly and use `import genlayer as gl` with
`gl.contract.Contract`, `gl.chain.Event`, `gl.contract.get_at`,
`gl.message.raw`, `genlayer.storage.allow`, and `on="decided"`.

Two behaviour changes were required, and neither is cosmetic:

1. **`exec_prompt` no longer asks for `response_format="json"`.** v0.6 runs
   `json.loads` inside the SDK and lets `JSONDecodeError` escape the nondet
   block uncaught, so a model answering in prose produced an unclassified
   Python traceback instead of the contract's own `[LLM_ERROR]` taxonomy — and
   `_handle_leader_error` could then no longer tell an expected model failure
   from a genuine VM fault. `_load_verdict_json` parses in-contract so that
   classification stays deterministic and identical on every validator.

2. **`_error_text` replaced a `getattr(err, "message", ...)` chain.** v0.6
   carries a `UserError` payload on `.data`; only `VMError` still uses
   `.message`. Reading the wrong attribute yields `""` silently, which would
   make every deterministic error compare equal to every other — two validators
   that failed for *different* reasons would have agreed.

`Contract` and `Event` are deliberately NOT bare module-level imports: gltest's
direct loader picks the first class in `dir(module)` with `Contract` in its MRO,
so a bare import gets deployed instead of the real contract.

**Local stack upgraded to the v0.6 RCs:** genlayer-test 0.30.0rc2 (with [sim]),
genlayer-py 0.19.0rc2, genvm-linter 0.11.1rc2.

**Three RC defects worked around, all in the harness, none in the contracts**
(documented at each site in tests/direct/conftest.py and scripts/glsim_node.py):

  - genlayer-py 0.19.0rc2 writes the calldata method under the EMPTY key, but
    glsim 0.30.0rc2 still reads `"method"` — the RC's own two halves disagree.
    Every write and every cross-contract call through the local node failed
    ("No method in calldata", and `.None()` in the node log) until the node
    aliased one string. Studio Next is unaffected; its node half is the real
    consensus stack.
  - gltest pre-parses a JSON-looking LLM mock into a dict, which v0.6 rejects
    ("text result is not a string"). Handing back the raw string is what the
    real executor does, so this makes both harnesses MORE faithful, not less.
  - genlayer-py 0.19.0rc2 dropped the receipt's `status` field in favour of a
    lowercase `lifecycle.state`. `status_name_of` now handles all four
    spellings rather than trusting one.

**Deploy plumbing: `withRunnerFor` -> `verifyRunnerPin`.** The old function
rewrote the pin at deploy time so one source could target both generations.
That is wrong now: the source is v0.6-only, so swapping in the v0.5 pin would
produce a contract the node accepts and that then dies at import on-chain, for
reasons the pin comment would actively hide. It now verifies and refuses —
confirmed against testnet-bradbury, which is turned away before any transaction
is sent.

## KNOWN ISSUES

`sim_estimateTransactionFees` returns "execution failed" on Studio Next for some
writes. Non-fatal — the demo falls back and the transactions finalize — but the
fee quote is missing for those calls and the cause is not yet understood.

## STILL TO DO

  - Connect the frontend console to Studio Next and verify it in a browser.
  - Record the mandatory demo video.
  - Update README (it still tells the Bradbury story; needs the live addresses
    and the Studio Next truth).
  - Portal submission.

*(The superseded Phase 6 "blocked on network access" and Phase 7 "deploy not
yet done" status blocks were removed here: both are resolved. The history is in
the sections below.)*

This file is the session handover. It records what was built, what was decided and
why, what was discovered about the toolchain, and exactly where to pick up.

---

## 1. What AutoShield is

Autonomous emergency response for smart contracts, for the GenLayer Agent Tank
Hackathon. A protected protocol has suspicious activity reported against it with
evidence. A GenLayer Intelligent Contract evaluates whether the evidence indicates an
active exploit, and the system responds at exactly one of three levels — **SAFE**,
**PROTECT**, **HALT** — through deterministic, bounded, self-expiring on-chain actions.

**The central design commitment, which must not be weakened:**

> The LLM never chooses the response level. The non-deterministic evaluation returns
> only a **severity score 0–100** and **six closed-set boolean signal flags**. A pure
> deterministic function, `derive_level()`, alone maps those to SAFE / PROTECT / HALT.

**The anti-brick guarantee:** a false positive cannot permanently disable the protocol.
Every response has an absolute deadline, modes decay lazily with no transaction needed,
HALT steps down through RESTRICTED rather than straight to NORMAL, repayment is never
blocked in any mode, and AutoShield has no power to move a single unit of value.

---

## 2. Where the work lives

- **Project folder (source of truth):** `C:\Users\ankik\Documents\AutoShield`
- **Cloud workspace used during sessions:** `/home/claude/autoshield` (ephemeral — the
  folder above is authoritative)
- Design docs also saved to the Claude Project: `claude/phase1-implementation-plan.md`,
  `claude/phase2-architecture.md`.

```
contracts/
  demo_lending.py      DemoLendingProtocol -- protected protocol, 100% deterministic
  autoshield.py        AutoShield -- controller, registry, adjudicator, policy engine
tests/direct/          235 tests, no network needed
tests/integration/     38 tests against a real GenLayer Sim node
scripts/glsim.sh       start / restart / stop the local node
scripts/glsim_node.py  node launcher with two documented compatibility shims
docs/ARCHITECTURE.md   full design + "Consensus Verification" section
frontend/              Security Operations Console (Next.js 16 + TypeScript), 74 tests
  app/                 dashboard (/) and incident detail (/incidents/[id])
  components/          presentational only -- no contract call anywhere in here
  lib/contracts/       service.ts + decode.ts -- the ONLY place that touches the chain
  lib/genlayer/        client construction, wallet, NETWORK identity + verification
  lib/demo/            quarantined demo engine, never mixed with chain data
  lib/state/           useAutoShield -- the single orchestrator hook
  scripts/             deploy-local.mjs, deploy-testnet.mjs
deployments/           per-network deployment records (public info only; empty so far)
```

---

## 3. Phase status

| Phase | Scope | State |
|---|---|---|
| 1 | Inspection + technical plan | done |
| 2 | Blockchain foundation (both contracts, state machine, anti-brick) | done, 153 tests |
| 3 | GenLayer adjudication engine (`gl.vm.run_nondet`) | done, 235 tests |
| 4 | Integration + consensus testing on GLSim | done, +38 tests |
| 5 | Frontend + demo experience | done, +60 tests |
| 6 | Public testnet deployment | superseded by 7 — Bradbury/Asimov reject these contracts on a measured ~2^24 per-tx gas cap |
| 7 | Studio Next migration (genlayer-js 2.0.0-rc.1, fees, v0.6 success semantics) | done; **first live deployment and first real adjudication** |
| 8 | Full move to consensus v0.6 — shims removed, local stack upgraded | **done; all suites green, redeployed and re-verified live** |

**Current totals: 234 direct (1 skipped) + 38 integration (1 skipped) + 75 frontend
(5 skipped) = 347.**
Contract lint and typecheck clean; frontend eslint, tsc and `next build` clean.
No test was deleted or weakened in the v0.6 migration. The direct suite still
collects 235; the one skip is `test_pickling_check` ("cloudpickle unavailable"),
which also skipped before the migration.

---

## 4. Verification commands

```bash
cd <project folder>
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt

# lint + typecheck
.venv/bin/genvm-lint check contracts/demo_lending.py
.venv/bin/genvm-lint check contracts/autoshield.py
.venv/bin/genvm-lint typecheck contracts/autoshield.py

# direct tests (no network) -- restart the node first, see the note below
./scripts/glsim.sh restart 5
.venv/bin/python -m pytest tests/direct -q       # expect 234 passed, 1 skipped

# integration tests (local GenLayer Sim node) -- SEPARATE process, fresh node
./scripts/glsim.sh restart 5
.venv/bin/python -m pytest tests/integration -q  # expect 38 passed, 1 skipped

# NEVER run `pytest tests` in one go. GLSim executes every contract in one
# Python process and the SDK allows one Contract subclass per process, so a
# combined run fails 3 direct tests and a reused node fails the NEXT session's
# deploy with "not calldata encodable ...: CalldataAddress".

# frontend
cd frontend && npm install
npm run typecheck && npm run lint && npm test && npm run build
#   expect 69 passed + 5 skipped with no node; 74 passed with a node and a deployment

# testnet deployment (needs network access + a funded dedicated testnet account)
# Either an existing GenLayer CLI account:
cd frontend && KEYSTORE_PASSWORD='...' npm run deploy:testnet -- \
  --network testnet-bradbury --keystore ~/.genlayer/keystores/<name>.json \
  --operator 0xYourWallet
# or a raw key:
export TESTNET_PRIVATE_KEY=0x...        # dedicated testnet key, never a valuable one
cd frontend && node scripts/deploy-testnet.mjs --network studio-next
# testnet-bradbury / testnet-asimov are now REFUSED: they run consensus v0.5 and
# these contracts are v0.6-only source. Use `node` directly, not `npm run` --
# npm strips `--flag value` pairs on Windows.

# frontend against a real node
./scripts/glsim.sh restart 5                                  # from the repo root
cd frontend && npm run deploy:local -- --operator 0xYourWallet
npm run dev
```

Always `restart` the node before an integration run — see limitation 8 below.

---

## 5. Toolchain (verified, do not drift without re-checking)

| Component | Version |
|---|---|
| Python | **>= 3.12 (mandatory)** |
| **Consensus generation** | **v0.6 ONLY** — v0.5 is a protocol break away, not a downgrade |
| `genlayer-test` | **0.30.0rc2** (`[sim]` extra for integration) |
| `genvm-linter` | **0.11.1rc2** |
| `genlayer-py` | **0.19.0rc2** |
| `genlayer` CLI (npm) | 0.39.2 |
| `genlayer-js` | **2.0.0-rc.1** (v1.1.8 kept aliased as `genlayer-js-v1` for localnet tooling) |
| Node.js | >= 20 |
| Next.js / React / Tailwind | 16.3.5 / 19.3.0 / 4.3.3 |
| TypeScript | **6.x — NOT 7.x** (typescript-eslint does not support 7 yet) |
| Vitest / Testing Library | 5.x / 16.x + jsdom |
| GenVM runner pin | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` (v0.6; the v0.5 hash `1jb45aa8...` is recognised only to be refused) |

**Python 3.11 trap:** pip silently resolves `genlayer-test` to 0.1.2, which has no
direct-mode fixtures. The suite then looks broken for no visible reason.

---

## 6. Decisions taken, and why (do not silently reverse)

1. **`derive_level()` is the only authority.** The evaluator emits a number and six
   booleans; `_parse_verdict` rebuilds the verdict from exactly those seven fields, so an
   injected `{"level": "HALT"}` is never read — not filtered, never read.
2. **`record_evaluation` was removed in Phase 3**, replaced by `adjudicate()`. Keeping it
   would have left a privileged caller able to inject severity 100 and bypass consensus.
3. **`run_nondet`, not `run_nondet_unsafe`** — the validator re-runs an LLM call and
   parses output; an exception there must not become an unconditional `Disagree`.
4. **Consensus rule (`_compare_verdicts`)**: booleans must match **exactly**; severities
   within **±15**; and `derive_level` must land on the **same level** — the binding
   condition, so 74 vs 75 is a disagreement despite being within tolerance.
5. **`SEVERITY_TOLERANCE = 15` is unchanged and uncalibrated.** It must only be changed
   from measured live-LLM data, never widened to make a test pass.
6. **Anti-spam is non-monetary** (allowlist + cooldown + caps + rate window). A bond would
   require AutoShield to custody value — exactly the power the design denies it.
7. **`evidence_uri` is never fetched on-chain** — SSRF vector and consensus hazard. The
   console does not fetch it either; it renders it as inert text, never as a link.
8. **Reverting transactions must not write.** Contracts never "mark stale, then raise";
   the permissionless `expire_incident` does the transition in a committing transaction.
9. **Prompt injection**: reporter-controlled fields are flattened, capped, stripped of
   fence markers and wrapped in labelled `<<<UNTRUSTED ... >>>` blocks. Not a complete
   defence, and documented as such — the blast radius is bounded architecturally.

### Phase 5 decisions

10. **The console never derives a response level.** `decode.ts#toLevel` returns `""` for
    anything that is not exactly SAFE/PROTECT/HALT, and the "why this decision?" panel
    asks the contract's own `preview_level` view. If the view and the stored level
    disagree, the panel says so instead of choosing one.
11. **Submitted is not success.** `service.ts#write` reports `succeeded` only when the
    node says `execution_result === "SUCCESS"`; a GenLayer transaction can reach
    ACCEPTED/FINALIZED with the contract reverted and no state changed.
12. **Simulated is always labelled.** `ConsensusOutcome.fromChain` distinguishes
    receipt-derived validator rows from demo-scripted ones, and
    `TransactionState.simulated` marks non-chain actions. Demo mode never renders as
    consensus.
13. **The demo engine is quarantined** in `lib/demo/`. It contains a documented
    demo-only mirror of `derive_level()`; chain mode never uses it.
14. **One ticking clock, in the hook.** React 19's compiler lint forbids `Date.now()`
    during render, so `useAutoShield` owns a 1s tick anchored to the chain's reported
    timestamp and passes `now` down as a prop. Do not reintroduce per-component clocks.
15. **Contract calls live in one layer.** Components import no client. `AutoShieldService`
    owns addressing, encoding, receipt interpretation and the write lifecycle.
16. **The chain id is verified, not trusted.** `reportedChainId()` asks the node over
    `eth_chainId`; a mismatch raises a wrong-network alert rather than quietly reading a
    different deployment.
17. **No secrets in the frontend, by construction.** Only `NEXT_PUBLIC_*` addresses and
    the RPC URL, all world-readable by design; the deploy script's key is ephemeral and
    never written to disk. `.env.local` is gitignored.

### Phase 6 decisions

17b. **The public path is Demo mode; chain writes stay operator-only.** Decided
    explicitly by the user when the question came up of how a public audience uses a
    system whose reporter list is an allowlist. Anyone can READ everything with no
    wallet, and anyone can run the entire flow in Demo mode with no wallet and no
    permissions. On-chain reporting stays allowlisted, because an open reporting
    endpoint is a free denial-of-service surface against the protected protocol — the
    anti-spam property from decision 6. No contract change was made, and the option of
    adding open self-registration was considered and declined. If specific addresses
    (judges, testers) need real on-chain reporting, the owner grants it per address with
    `set_reporter(address, true)` — no redeploy needed.

18. **A network is identified by NAME, never by chain id.** Verified against both
    installed sources (genlayer-js@1.1.8 and CLI 0.39.2): testnet-bradbury and
    testnet-asimov BOTH report chain 4221, and studionet reports 61999 — the same id
    glsim.sh runs locally. The Phase 5 code selected the chain by id, so
    `CHAIN_ID=61999` silently resolved to *studionet* (carrying studionet's consensus
    contract) and `4221` resolved to whichever of the two testnets came first in an
    array. Fixed: `NEXT_PUBLIC_GENLAYER_NETWORK` names the network, its endpoint and
    chain id come from that definition, and env vars can no longer repoint a public
    network. The chain-id override survives for localnet only, where glsim needs it.
19. **A wrong network REFUSES TO SIGN.** Phase 5 warned and carried on. Now every chain
    write passes through one gate that throws while the verdict is "mismatch"; reads
    keep running so the operator can see what they are actually connected to.
20. **Live tests must skip visibly, never vacuously.** The first version of the
    live-chain test returned early when no node was reachable, which reports as a green
    pass — the exact failure mode the project forbids. Reachability is now resolved
    before the suite is defined, so it reports as skipped.

---

## 7. Known limitations (carry forward honestly)

1. **Multi-validator agreement has been executed; convergence has NOT been observed.**
   With mocked evaluation every validator sees the same canned answer, so unanimity is
   guaranteed by construction. Do not claim "consensus verified".
2. **Induced validator disagreement is not reachable through GLSim's mock API** (static
   mocks ⇒ identical answers). Direct-mode `run_validator` tests cover the comparison
   logic against chosen leader results.
3. **Severity variance is unmeasured.** The measurement test exists and skips unless
   `AUTOSHIELD_LLM_PROVIDER` + the provider API key are set (env vars only, never in
   source). Running it is the prerequisite for touching the tolerance.
4. **Appeals are not exercised** (`getAppealCharge` / `appealTransaction`), and the
   console has no appeal control.
5. `_iso_to_ts` is duplicated across both contracts; sharing it would need the
   `py-genlayer-multi` runner and is not worth it at this size.
6. **Device shell could not mount the project folder** during these sessions (a Windows
   update from Sept 8 breaks it). Work was done in the cloud workspace and committed to
   the folder. If that persists, keep using the same approach.
7. **Neither contract has an ownership-transfer path.** So the owner-only escape hatches
   (`clear_response`, `set_paused`) belong to the deployer key and cannot be driven from
   a browser wallet. The console surfaces the contract's rejection honestly rather than
   hiding the button. Changing this would be a contract change, deliberately deferred.
8. **The console has not been exercised against a browser wallet.** The MetaMask Snap
   path (`client.connect()`) is the supported genlayer-js@1.1.8 API and is wired, but no
   real wallet session has been run. Chain reads, writes, consensus receipts and the
   whole deploy path *have* been verified against GLSim.
9. **Frontend tests are component and decoder tests**, not end-to-end browser tests.

---

## 8. Environment quirks found (all reproduced against genlayer-test 0.29.2)

These cost real time to diagnose. They are documented in `docs/ARCHITECTURE.md` §10a and
in the test conftests, but keep them in mind.

| # | Finding | Handling |
|---|---|---|
| 1 | **Contract source must be pure ASCII** — `genlayer_py` hex-encodes via `eth_utils.encode_hex`, which does `.encode("ascii")`; one em dash breaks schema retrieval | both contracts are ASCII; keep them that way |
| 2 | `Address` args die at glsim's decode→re-encode boundary (`not calldata encodable addr#...: CalldataAddress`) | shim in `scripts/glsim_node.py` |
| 3 | `sim_increaseTime` never reached the contract clock (measured 0s for 10000s) because `VMContext.warp` doesn't write `gl.message_raw['datetime']` | clock shim in `scripts/glsim_node.py`, guarded by a test |
| 4 | `gen_getContractSchemaForCode` and deploy share a class cache and poison each other | ABI taken from `genvm-lint schema --json` |
| 5 | glsim default chain id 61127 vs `genlayer_py.chains.localnet` 61999 | `scripts/glsim.sh` sets `--chain-id 61999`; the console overrides it via `NEXT_PUBLIC_GENLAYER_CHAIN_ID` |
| 6 | `sim_createSnapshot` records key sets only, not storage values | isolation via `expire_incident` / `clear_response` |
| 7 | `sim_installMocks` appends while first-match wins, so stale mocks shadow new ones | one throwaway read between install and use |
| 8 | One deploy per contract per glsim process (SDK allows one Contract subclass per process) | session-scoped deployment; `./scripts/glsim.sh restart` before each run |
| 9 | Direct mode: `warp` doesn't move the clock; one-contract-per-process global; all contracts share one storage root | three documented workarounds in `tests/direct/conftest.py` |
| 10 | `pydantic_core` binary was broken after installing the `[sim]` extra, silently breaking all schema clients | `pip install --reinstall pydantic pydantic-core` |
| 11 | GenLayer calldata has **no float type** (`calldata.encode(1.5)` raises) | fractional model output fails at the VM boundary before parsing |

### Frontend / genlayer-js quirks (Phase 5)

| # | Finding | Handling |
|---|---|---|
| 12 | `CalldataAddress` is **not** exported from `genlayer-js` — it lives in `genlayer-js/types`, and its constructor takes **20 raw bytes**, not a hex string ("invalid address length") | `toCalldataAddress()` in `lib/genlayer/client.ts`, mirrored in `deploy-local.mjs` |
| 13 | `TransactionHash` is a branded type (`` `0x${string}` & { length: 66 } ``); a plain cast is rejected | `hash as unknown as TransactionHash`, with the brand documented as compile-time only |
| 14 | `eslint-config-next` 16 is flat-config native; `FlatCompat` throws "Converting circular structure to JSON" | spread the exported arrays directly in `eslint.config.mjs` |
| 15 | React 19 compiler lint: `react-hooks/purity` forbids `Date.now()` during render, `react-hooks/set-state-in-effect` forbids mirroring a prop into state | single tick+anchor clock in `useAutoShield`, `now` passed as a prop |
| 16 | `--legacy-peer-deps` silently omits peers: `@testing-library/dom`, `vite`, `@eslint/eslintrc` were all needed explicitly | installed explicitly; do not remove them |
| 17 | Deploy receipts carry the address in different places across environments | `contractAddressOf()` checks `txDataDecoded.contractAddress`, `data.contract_address`, then `to_address`/`recipient` |
| 18 | A receipt's status can be NUMERIC rather than a name — glsim returns `7`, which IS FINALIZED — so comparing it to the string enum fails a perfectly good transaction | `statusNameOf()` normalises through the SDK's own `transactionsStatusNumberToName` |
| 18b | **Testnet Bradbury rejects the deploy with `-32602 ... gas limit too high`.** `deployContract` takes `estimateTransactionGas`'s answer verbatim — no cap, and no `gas` option on the public API. The contracts are ~50 KB and ~34 KB of source, all travelling as calldata | `clampGasToBlockLimit(rpc)` clamps `eth_estimateGas` results to 90% of the network's own block gas limit, with `AUTOSHIELD_MAX_GAS` as an override. **Not yet confirmed to fix Bradbury** — unverifiable from the sandbox |
| 18c | Replacing `client.estimateTransactionGas` does NOTHING: genlayer-js builds its contract actions over an INTERNAL client captured before the one `createClient` returns, so internal calls never see the replacement (observed directly — a deploy ignored the patch) | Intercept at the transport's `fetch` instead: narrow to the one RPC URL and the one method, and only ever lowering the value. Verified on a local node that `eth_estimateGas` really is issued on the deploy path and passes through the interceptor |
| 18e | `--estimate-only` first reported "fits" for two contracts the network had already refused, because it compared against the BLOCK gas limit instead of the per-transaction cap | Fixed: it compares only against a MEASURED cap (`AUTOSHIELD_MAX_GAS`) and otherwise says the cap is unknown and how to measure it. A false pass is worse than no answer |
| 18d | **Bradbury caps a single transaction at ~16,777,216 gas (2^24)** — measured, not guessed, by binary search over the gas limit of zero-value self-transfers (`scripts/probe-gas-cap.mjs`). The block gas limit is 100,000,000, so this is a per-transaction ceiling and the block limit is a red herring. Deploying `demo_lending.py` estimates 27,382,350 | **Measured and settled.** Asimov has the IDENTICAL cap (~16,716,711), so both public testnets are out. Deploy cost is linear at ~805 gas per source byte: DemoLendingProtocol 33,895 B -> 27,382,350 gas (1.64x over), AutoShield 49,797 B -> 39,976,062 gas (2.39x over). Stripping every comment and docstring reaches only 65% / 62% of size — still over, AutoShield by 50%. genlayer-js sends contract source uncompressed and offers no packing option. **Decision: deploy to StudioNet**, which is gasless, rather than gut six phases of tested architecture to satisfy one network's per-transaction limit |
| 19 | **On Windows**, `npm run <script> -- --flag value` silently drops the flag NAMES (npm consumes unrecognised pairs as its own config); the script sees only bare values. Works fine on Linux/macOS, so it is invisible in testing | Call `node scripts/<name>.mjs` directly; both scripts now detect the symptom and print the exact command to run |

**A self-inflicted lesson worth keeping:** a *guessed* package version
(`typescript@5.9.4`, which does not exist) sent npm backtracking for 25+ minutes on an
impossible constraint. Check real published versions before pinning.

---

## 9. Phase 6 — built, and what is left

**Built and verified this phase:**

- `frontend/scripts/deploy-testnet.mjs` — network by name, chain-id verification before
  signing, balance check with the faucet instruction, deploy -> FINALIZED + SUCCESS ->
  deploy -> wire -> verify wiring by on-chain read -> seed -> verify seed -> write
  `deployments/<network>.json` and `.env.local`. Every refusal path was exercised: no
  `--network`, unknown network, `mainnet`, `localnet`, missing key, malformed key,
  unreachable RPC. The key is never printed or written.
- Keystore v3 support, so an account that already exists in the GenLayer CLI can sign
  the deployment. The CLI has no raw-key export (`account export` writes another
  keystore), so the script decrypts the keystore itself with node:crypto + viem's
  keccak256 (viem was already in the tree via genlayer-js; it is now declared
  explicitly in package.json rather than imported transitively). Verified against a
  real `genlayer account create` keystore: the decrypted key derives exactly the
  address the CLI reports, a wrong password fails on the MAC, and supplying both a raw
  key and a keystore is refused rather than resolved by precedence.
- `frontend/scripts/demo-incident.mjs` — the whole incident lifecycle from the CLI, with
  no browser wallet anywhere. Prompted by the observation that a wallet need not be a
  browser wallet, which is right and is also the production model: the reporter is a
  monitoring service. **Verified end to end on a local node**, both branches (HALT with
  severity 88 and 5/5 agree votes; SAFE with severity 12 and no response applied).
  Shared plumbing extracted to `scripts/lib/genlayer.mjs` so the deploy and demo
  scripts cannot drift on what "succeeded" means.
- A third bug, found the same way: the `.env.local` address fallback did not check
  which network that file was written for, so a `--network testnet-bradbury` run would
  silently pick up localnet addresses. Now refused with a clear message.
- Two real bugs found by running it, both of which would have hit the testnet:
  (a) a receipt's status can be NUMERIC (glsim returns 7 = FINALIZED); comparing it to
  the string enum called a good transaction a failure. Now normalised through the SDK's
  own `transactionsStatusNumberToName`.
  (b) I had invented an incident category, `OTHER`. The contract accepts exactly four:
  ORACLE_DEVIATION, BORROW_ANOMALY, LIQUIDITY_DRAIN, TX_PATTERN. Exactly the "do not
  invent APIs" rule, caught by running against a real node rather than by reading.
- Network identity rewritten (see decision 18 below) plus 9 tests.
- Per-wallet permission awareness. The console reads `is_reporter(address)` plus the
  owner/evaluator from `get_config` and shows what THAT wallet may do, disabling the
  actions it cannot take with the reason. Prompted by a good question: `--operator` is
  one address, but every visitor brings their own wallet. The answer is that this is a
  guarded operator system by design, and the console should say so rather than offering
  buttons that fail on submission. Reading needs no wallet; Demo mode needs nothing.
- 5 live-chain tests that drive the console's own service layer against a real node.
- `.gitignore` hardened; verified empirically in a scratch repo that `.env`,
  `.env.local`, `.env.testnet`, `.env.production`, `*.key` and `keystore.json` are all
  unstageable while the two `.env.example` files remain committable.

**What is left, in order:**

1. **Get network access to a GenLayer testnet.** This session has none (see the status
   block at the top). Run the deployment from a machine that can reach
   `rpc-bradbury.genlayer.com`.
2. **Fund a dedicated testnet account** at <https://testnet-faucet.genlayer.foundation/>
   — Cloudflare-gated, 100 GEN per address per 24h, must be claimed in a browser.
3. **Deploy:** `npm run deploy:testnet -- --network testnet-bradbury --operator 0x...`
4. **Exercise the end-to-end incident flow** on the deployed contracts, and the browser
   wallet path (`client.connect()`, MetaMask Snap), which has still never been run.
5. **Measure real consensus and real LLM variance.** This is the whole point of going to
   a public testnet: on GLSim, mocked evaluator responses make validator unanimity
   automatic. Record the per-transaction consensus block the deploy script already
   captures, run the same scenario several times, and only then consider whether ±15 is
   right. Never widen it to make a run agree.

Studio rate limits, if studionet is used instead: 60 req/min, 1000/hr, 10000/day;
`-32028` at 32 in-flight txs per sender.

`gltest.config.yaml` still has `paths` only. The `testnet_bradbury` network block is
deliberately absent — `${...}` placeholders resolve eagerly for every listed network, so
listing it without `ACCOUNT_PRIVATE_KEY_1` set breaks the whole test run.

Optional, if ownership from the browser matters for the demo: an ownership-transfer or
operator-role path on `DemoLendingProtocol` (see limitation 7). That is a **contract
change** and needs its own phase approval and test coverage.

**Working rules to keep following:** use the installed genlayer-dev skill; verify APIs
against installed source before using them; never invent APIs; no secrets in source;
don't weaken existing tests to make new ones pass.
