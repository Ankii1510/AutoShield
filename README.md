# AutoShield

Autonomous emergency response for smart contracts, built on GenLayer.

A protected protocol can have suspicious activity reported against it with evidence. A
GenLayer Intelligent Contract evaluates whether that evidence indicates an active
exploit, and the system responds at one of exactly three levels — **SAFE**, **PROTECT**,
**HALT** — through deterministic, bounded, self-expiring on-chain actions.

**Status: live on GenLayer Studio Next (chain 61997, consensus v0.6).**

```
DemoLendingProtocol  0x054be2be73d15DB1B13d836F4045612AB65c685A
AutoShield           0x7834967C394e6831c34710134afc0BfFFD9eeA8E
network              studio-next  (chain 61997)  https://studio-next.genlayer.com/api
runner               py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng
deployed             2026-09-15    record: deployments/studio-next.json
```

234 direct-mode tests, 38 integration tests against GenLayer Sim with five
validators executing the contract's own validator function on every
adjudication, and 80 frontend tests. Both contracts pass `genvm-lint check`.

**Two incidents have run end to end on Studio Next against real validators and a
real model:**

| Incident | Scenario | Severity | Signals | Level | Votes |
|---|---|---|---|---|---|
| INC-2 | `critical` | 82 | `price_manipulation`, `liquidity_drain` | **HALT** — protocol HALTED, repayment still open | 3 agree, 2 idle |
| INC-1 | `oracle` | 32 | none | **SAFE** — no response applied | 3 agree, **2 disagree** |

The second row is the more interesting one. Two validators genuinely disagreed
with the leader and the transaction still finalized on the majority — real
non-deterministic variance under real consensus. No local run can show that: on
GenLayer Sim every validator receives the same mocked evaluator response, so
unanimity is guaranteed by construction. Mocked runs always returned severity
88; these returned 82 and 32.

---

## The core idea

The LLM never chooses the response level.

`adjudicate()` runs the evaluation through `gl.vm.run_nondet(...)`, and it returns only a
**severity score (0–100)** and a **closed set of six boolean signal flags** — seven keys,
no prose. A pure deterministic function, `derive_level()`, maps those to
SAFE / PROTECT / HALT. A model that emits `"level": "HALT"` is not filtered; that key is
never read. Judgment goes to GenLayer consensus, where independent
validator re-evaluation is worth paying for; the consequential decision stays in
auditable code.

And a false positive cannot brick the protocol: every response carries an absolute
deadline, modes decay on their own with no transaction required, HALT steps down through
RESTRICTED rather than straight to NORMAL, repayment is never blocked in any mode, and
AutoShield has no power to move a single unit of value.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

---

## Layout

```
contracts/
  demo_lending.py     DemoLendingProtocol — the protected protocol (deterministic)
  autoshield.py       AutoShield — incident controller, registry, policy engine
tests/direct/         235 direct-mode tests (no network required)
tests/integration/    38 tests against a real GenLayer Sim node with 5 validators
scripts/glsim.sh      start / restart / stop the local node
docs/ARCHITECTURE.md  design, state machines, authority boundaries, security model
docs/DEPLOY-CONSOLE.md hosting the console, and the checklist that proves it is on chain
docs/DEMO-VIDEO.md    the recording script
docs/PROGRESS.md      phase-by-phase history and handover
frontend/             the Security Operations Console (Next.js + TypeScript)
  app/                dashboard and incident detail routes
  components/         presentational panels, no contract calls anywhere in here
  lib/contracts/      the only place that reads or writes the chain
  lib/genlayer/       client construction, wallet, network verification
  lib/demo/           the quarantined demo engine, never mixed with chain data
  scripts/            deploy-testnet.mjs, demo-incident.mjs, fund-account.mjs
deployments/          per-network deployment records — public information only
```

---

## Setup

**Python ≥ 3.12 is required.** On 3.11, `pip` silently resolves `genlayer-test` to 0.1.2,
which has no direct-mode fixtures — the test suite then appears broken for no visible
reason.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm install -g genlayer@0.39.2      # CLI, optional; used for keystore accounts
```

`requirements.txt` pins **release candidates** (`genlayer-test==0.30.0rc2`,
`genvm-linter==0.11.1rc2`, `genlayer-py==0.19.0rc2`), so install with `--pre`:

```bash
.venv/bin/pip install --pre -r requirements.txt
```

**Consensus v0.5 -> v0.6 is a protocol break, not a library bump.** Both contracts
use v0.6-only SDK spellings and carry the v0.6 runner pin. Downgrading any of
those pins does not fall back to a working v0.5 setup — it produces a suite that
fails in ways that look like contract bugs.

## Lint

Always lint before testing.

```bash
.venv/bin/genvm-lint check contracts/demo_lending.py
.venv/bin/genvm-lint check contracts/autoshield.py
.venv/bin/genvm-lint typecheck contracts/autoshield.py
```

## Test

Direct mode needs no network:

```bash
./scripts/glsim.sh restart 5
.venv/bin/python -m pytest tests/direct -q
```

Expected: **234 passed, 1 skipped** (the skip is `test_pickling_check` —
cloudpickle is not installed).

Integration tests run against a local GenLayer Sim node — one leader plus five
validators, real consensus voting, real cross-contract delivery:

```bash
.venv/bin/pip install --pre 'genlayer-test[sim]==0.30.0rc2'
./scripts/glsim.sh restart 5
.venv/bin/python -m pytest tests/integration -q
./scripts/glsim.sh stop
```

Expected: **38 passed, 1 skipped**. They skip with an explicit message if no node is
reachable, and never silently pass.

**Run the two suites separately, each against a freshly restarted node. Never
`pytest tests` in one go.** GenLayer Sim executes every contract in one Python
process and the SDK allows one Contract subclass per process, so a combined run
fails 3 direct tests and a reused node fails the *next* session's deploy with
`not calldata encodable ...: CalldataAddress`. This is a harness constraint, not
a contract defect.

Optionally run the evaluator against a real model — no secrets in source, environment
variables only:

```bash
export AUTOSHIELD_LLM_PROVIDER=openai:gpt-4o-mini
export OPENAI_API_KEY=...          # or ANTHROPIC_API_KEY for anthropic:*
./scripts/glsim.sh restart 5
```

That enables the severity-variance measurement, which is the only honest basis for
calibrating `SEVERITY_TOLERANCE`. See `docs/ARCHITECTURE.md`, "Consensus Verification",
for exactly what each layer does and does not prove.

The first run downloads the GenVM SDK bundle (~215 MB) to `~/.cache/gltest-direct`. If it
is interrupted, delete `~/.cache/gltest-direct/extracted` before retrying — a partial
extraction surfaces later as a confusing `No module named 'genlayer'`.

---

## The console

A dark security-operations console rather than a wallet dapp: the protected protocol, a
live threat monitor, the current protection state with its countdown, the five GenLayer
validators, and the current incident, all on one screen.

```bash
cd frontend
npm install
npm run dev            # http://localhost:3000
```

### Hosting it

The console is a browser client for contracts that already exist on chain: no
server, no database, and no secret — every value it needs is a `NEXT_PUBLIC_*`
address compiled into the bundle, and Studio Next answers with
`access-control-allow-origin: *`, so the page calls the chain directly.

```bash
cd frontend
npx vercel deploy --prod \
  --build-env NEXT_PUBLIC_GENLAYER_NETWORK=studio-next \
  --build-env NEXT_PUBLIC_PROTOCOL_ADDRESS=0x054be2be73d15DB1B13d836F4045612AB65c685A \
  --build-env NEXT_PUBLIC_AUTOSHIELD_ADDRESS=0x7834967C394e6831c34710134afc0BfFFD9eeA8E
```

They must be **build** env vars: Next.js inlines `NEXT_PUBLIC_*` while compiling,
so setting them afterwards changes nothing until the next build. `.vercelignore`
keeps `scripts/` — the only code that ever touches a private key — off the host.

**After deploying, check the header does not say "Simulated — no chain".** Demo
mode is the fallback when no addresses are configured, and it renders a complete,
convincing incident flow with no chain behind it. Full checklist:
[`docs/DEPLOY-CONSOLE.md`](docs/DEPLOY-CONSOLE.md).

With no configuration it starts in **Demo mode**, which runs the whole flow with no node
at all. Demo mode is labelled everywhere it appears, validator rows are marked
`Simulated`, and simulated actions are never presented as transactions.

### Running against a real node

```bash
./scripts/glsim.sh restart 5                                  # from the repo root
cd frontend
npm run deploy:local -- --operator 0xYourWalletAddress        # writes .env.local
npm run dev
```

`scripts/deploy-local.mjs` deploys both contracts, performs the one-shot guard wiring,
grants the reporter and evaluator roles, seeds demo liquidity, reads the result back off
the chain and writes the two public addresses into `frontend/.env.local`. The deployer key
is generated per run and never written to disk; set `AUTOSHIELD_DEPLOYER_KEY` to reuse
one. `npm run deploy:local -- --help` lists every option.

Neither contract has an ownership-transfer path, so the owner-only escape hatches
(`clear_response`, `set_paused`) stay with the deployer key. A connected browser wallet
can report and adjudicate; an owner-only write from the browser is rejected by the
contract and the console shows that rejection rather than hiding it.

### What the console will not do

- It never displays a response level it derived itself. `PROTECT` and `HALT` are read from
  the chain, and the "why this decision?" panel asks the contract's own `preview_level`
  view; if the two ever disagree, the panel says so rather than picking one.
- It never shows model reasoning. Only the structured evaluation — one severity and six
  booleans — and the deterministic rule that acted on it.
- It never reports a write as successful because it was submitted. A write is confirmed
  only when the node reports `execution_result == "SUCCESS"`; on GenLayer a transaction can
  reach ACCEPTED or FINALIZED with the contract having reverted and no state changed.
- It never claims consensus it did not observe. Validator rows carry the receipt's actual
  votes, and rows that did not come from a chain are marked as simulated.
- It never fetches `evidence_uri`. The reference is rendered as inert text; fetching a
  reporter-supplied URL would be an SSRF vector.
- It holds no secrets. Every `NEXT_PUBLIC_*` value is compiled into the browser bundle, so
  only public addresses and the RPC URL live there; `.env.local` is gitignored.

The console also verifies that the node it is talking to actually reports the configured
chain id, and raises a wrong-network alert instead of quietly describing a different
deployment.

### Attack simulator

Six scenarios — normal operation, oracle anomaly, liquidity drain, borrowing anomaly,
coordinated suspicious activity, and a critical exploit pattern — each showing the
expected before-and-after. They move the demo protocol's own reported telemetry through
its owner-only `simulate_*` methods. There is no exploit mechanic anywhere in this
repository and nothing here touches a real protocol.

---

## Live network

### Networks, and why the name matters

| Network | Chain id | Consensus | RPC |
|---|---|---|---|
| **`studio-next`** | **61997** | **v0.6** | `https://studio-next.genlayer.com/api` |
| `studio-dev` | 61997 | v0.6 | `https://studio-dev.genlayer.com/api` |
| `localnet` | 61999 | local sim | `http://127.0.0.1:4000/api` |
| `studionet` | 61999 | v0.5 | `https://studio.genlayer.com/api` |
| `testnet-bradbury` | **4221** | v0.5 | `https://rpc-bradbury.genlayer.com` |
| `testnet-asimov` | **4221** | v0.5 | `https://rpc-asimov.genlayer.com` |

**A chain id does not identify a GenLayer network.** Bradbury and Asimov both
report 4221 and differ only in endpoint and consensus contract; studionet reports
61999, which collides with the local sim. So the console and every script select a
network by **name** (`NEXT_PUBLIC_GENLAYER_NETWORK`), take the endpoint and chain id
from that named network, and verify both against the node before signing anything.
On a mismatch the console **refuses to sign** and says why; reads keep running so
you can see what you are actually connected to.

**`studio-next` is the deployment target.** The v0.5 networks are now **refused** by
the deploy script: these contracts are v0.6-only source, and deploying them to a
v0.5 network would produce a contract the node accepts and that then dies at import,
on-chain. The refusal happens before any transaction is sent.

### Why not Bradbury

Bradbury and Asimov were the original target and are a measured dead end for these
contracts. Both enforce a per-transaction gas cap of roughly 2^24 (measured at
16,716,711 by binary search, identical on both), and these contracts estimate
27,382,350 and 39,976,062 — so both deploys are rejected with `gas limit too high`
before anything runs. `frontend/scripts/probe-gas-cap.mjs` is the measurement.

### Deploying

**Call `node` directly, not `npm run`.** On Windows npm treats unrecognised
`--flag value` pairs as its own config and swallows them, so the script receives
only the bare values and rejects them. The scripts detect that case and say so,
but `node` avoids it entirely.

Two ways to supply the signing account — pick one, never both.

**A. Reuse an existing GenLayer CLI account** (`genlayer account list` for its name):

```bash
cd frontend
KEYSTORE_PASSWORD='your-account-password' \
  node scripts/deploy-testnet.mjs --network studio-next \
    --keystore ~/.genlayer/keystores/<name>.json
```

The CLI has no raw private-key export — `genlayer account export` writes another
keystore — so the script reads the keystore itself (standard v3: scrypt/pbkdf2,
AES-128-CTR, keccak MAC). The key stays encrypted at rest and the password lives in one
command's environment. A wrong password fails on the MAC rather than producing a
plausible but wrong key.

**B. Use a raw key:**

```bash
export TESTNET_PRIVATE_KEY=0x...     # a DEDICATED testnet key, in the shell only
cd frontend
node scripts/deploy-testnet.mjs --network studio-next
```

Add `--operator 0xYourWalletAddress` to give a browser wallet the reporter and
evaluator roles; it defaults to the deployer. `--estimate-only` quotes fees and
gas and blocks broadcast at the transport, so it cannot send by accident.

The script deploys `DemoLendingProtocol`, waits for **FINALIZED with a successful
execution result**, deploys `AutoShield` the same way, wires the guard and roles,
verifies the wiring by reading it back off the chain, seeds demo liquidity, verifies
the seeded totals, and writes `deployments/studio-next.json` plus
`frontend/.env.local`. Any failure stops before the next transaction and writes
`deployments/last-failure-<network>.json` with the full receipt.

It refuses to run without an explicit `--network`, refuses an unknown network,
refuses `mainnet` and `localnet` (**there is no mainnet path**), refuses every v0.5
network, refuses a contract whose runner pin is not the v0.6 one, refuses a missing
or malformed key, refuses an unfunded account, and refuses a node whose chain id does
not match. The key is read from the environment, never written to a file, never
included in the deployment record, and never printed — not even partially.

### Funding

Studio Next charges fees, and the public faucet at
<https://testnet-faucet.genlayer.foundation/> funds Bradbury and Asimov, **not chain
61997**. Studio networks expose `sim_fundAccount` instead:

```bash
cd frontend
node scripts/fund-account.mjs --network studio-next --amount 100
```

It converts GEN to wei (the RPC takes wei — `--amount 50` credited exactly 50 wei
before that was fixed), polls the balance to confirm the credit actually landed, and
refuses any non-simulated network rather than pretending. For Bradbury or Asimov,
claim from the faucet in a browser — it is Cloudflare-gated and cannot be automated.

### Who this is for

AutoShield is deployed **per protocol**, not run as one shared service. Three different
people are involved, and conflating them causes most of the confusion about permissions:

| Who | What they do | Wallet? |
|---|---|---|
| **The protocol team** | Deploys their *own* AutoShield instance pointing at their own protocol. They are its owner and operator. | yes, theirs |
| **The protocol's end users** | Nothing. They are simply protected — and in any mode, repayment stays open to them. | no |
| **Watchers / security researchers** | File incidents with evidence, once the protocol team allowlists them. | yes |

So the operator address is not a project-wide superuser: it is *that deployment's*
operator. A hundred protocols adopting AutoShield means a hundred independent
deployments, each with its own owner, its own allowlist, and its own protected protocol.

The deployment in this repository is a **demonstration instance**: it guards
`DemoLendingProtocol`, which exists only to be protected.

### Who can do what

AutoShield is a **guarded security system, not an open dapp**, and the console now says
so per-wallet. After connecting, a "Your permissions" panel reads the contract and shows
what that specific address may do:

| Action | Who |
|---|---|
| Read everything | anyone, **no wallet needed** |
| Report an incident | allowlisted reporters (`set_reporter`, owner-only) |
| Run adjudication | the single evaluator address |
| Execute an adjudicated response | **anyone** — permissionless by design |
| Expire a stale incident | **anyone** — permissionless by design |
| Clear response / pause | the owner |

The restrictions are the design working. An open reporting endpoint would be a free
denial-of-service surface against the protected protocol — anyone could file incidents
until the open slots filled. The two permissionless actions are permissionless on
purpose: both only move the system toward safety or recovery, so neither may depend on
one key being online.

For anyone who wants to drive the whole flow themselves, **Demo mode** needs no wallet
and no permissions at all. To grant a specific address reporting rights, the owner calls
`set_reporter(address, true)`.

### Running the demo without any browser wallet

AutoShield is an autonomous system: in production the thing that files an incident is a
**monitoring service**, not a person clicking a button. So the reporter and evaluator are
ordinary backend accounts, and the whole flow runs from the command line:

```bash
cd frontend
node scripts/demo-incident.mjs --network studio-next \
  --keystore ~/.genlayer/keystores/<name>.json --scenario critical
```

Again, `node` rather than `npm run` — see "Deploying" above.

Open the console in a browser alongside it and watch the dashboard react — it polls the
same chain state, so the protocol card, validator panel and countdown update on their own
with nothing connected.

Scenarios: `normal`, `oracle`, `liquidity`, `borrow`, `coordinated`, `critical`.
Add `--repeat N` to run one scenario several times and report the spread of severities,
signal flags and levels. `--no-execute` adjudicates without applying the response.

The script checks its permissions before signing, verifies the chain id, requires every
transaction to reach FINALIZED **and** execute successfully, reads the severity, signals
and level back **from the chain**, and cross-checks that level against the contract's own
`preview_level` view — a mismatch stops the run rather than being reported as a result.
It also fails loudly if repayment is ever disabled, since that would break the anti-brick
guarantee.

It waits out the reporter cooldown rather than bypassing it. (On `localnet` only, whose
chain clock does not follow wall time, it advances the simulator's clock instead — the
same mechanism the integration suite uses, and unreachable on a public network.)

**Verified on Studio Next, end to end** (the two runs in the table at the top of this
file, recorded in `deployments/studio-next-demo-*.json`): NORMAL → simulated
observation → real incident → real adjudication under validator consensus → severity
and signals read back from the chain → level cross-checked against `preview_level` →
response executed → protocol HALTED with repayment still enabled.

The same flow was verified earlier on a local node, where the mocked evaluator always
returned severity 88 with 5/5 agree votes. Those numbers are a property of the mock,
not evidence about consensus — which is exactly why the Studio Next runs matter.

### Connecting a wallet

The console uses GenLayerJS's MetaMask Snap integration (`client.connect()`). Press
**Connect wallet**, approve the Snap, and the header shows the address and the chain.
Pass that wallet's address as `--operator` at deploy time so it holds the reporter and
evaluator roles.

**This path has never been exercised against a real wallet.** It is wired and it
typechecks; no browser wallet session has been run. Everything else in this section
has been verified against a live chain.

Owner-only actions (`clear_response`, `set_paused`) stay with the deployer key, because
neither contract has an ownership-transfer path. The console shows the contract's
rejection rather than hiding the control.

### What is real and what is simulated

```
SIMULATED OBSERVATION      the attack simulator moves the demo protocol's own
        |                  reported telemetry; no exploit code, no real protocol
        v
REAL INCIDENT TRANSACTION  a real write to AutoShield on the selected network
        |
        v
REAL GENLAYER ADJUDICATION gl.vm.run_nondet under validator consensus
        |
        v
REAL ON-CHAIN RESULT       severity + six flags stored; derive_level() decides
```

Only the first box is simulated, and it is labelled as such everywhere it appears. In
**Demo mode** — which is the default when no addresses are configured — all four boxes
are simulated, the header says "Simulated — no chain", and validator rows are marked
`Simulated` rather than presented as consensus.

### Limitations, stated plainly

- **The browser wallet path has never been run.** See "Connecting a wallet" above.
  The console has been verified against the live chain through its own service layer
  (client construction, calldata encoding, contract reads, decoding) — the five
  live-chain tests read Studio Next directly — but no MetaMask Snap session exists.
- **Validator variance has been observed once, and is not characterised.** The `oracle`
  run produced 3 agree / 2 disagree, which proves the validators evaluate
  independently. It does not tell you the distribution. `--repeat N` on
  `demo-incident.mjs` reports the spread, and that measurement has not been run at
  size.
- **`SEVERITY_TOLERANCE` is ±15 and uncalibrated.** It has not been changed, and must
  only ever change from measured live data, never to make a run agree.
- **`sim_estimateTransactionFees` returns "execution failed" on Studio Next for some
  writes.** Non-fatal — the scripts fall back and the transactions finalize — but the
  fee quote is missing for those calls and the cause is not yet understood.
- **Appeals are not exercised** (`getAppealCharge` / `appealTransaction`), and the
  console has no appeal control.
- **Neither contract has an ownership-transfer path**, so the owner-only escape hatches
  (`clear_response`, `set_paused`) stay with the deployer key and cannot be driven from
  a browser wallet. The console surfaces the contract's rejection rather than hiding
  the control. Changing this would be a contract change, deliberately deferred.
- **Frontend tests are component and decoder tests**, not end-to-end browser tests.

### Frontend checks

```bash
cd frontend
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # vitest — 80 tests (5 read a live node; they skip visibly without one)
npm run build          # production build
```

---

## Toolchain

| Component | Version |
|---|---|
| Python | ≥ 3.12 |
| Consensus generation | **v0.6 only** |
| `genlayer-test` | 0.30.0rc2 |
| `genvm-linter` | 0.11.1rc2 |
| `genlayer-py` | 0.19.0rc2 |
| `genlayer` (CLI) | 0.39.2 |
| GenVM runner | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` |
| Node.js | ≥ 20 |
| `genlayer-js` | 2.0.0-rc.1 (1.1.8 kept aliased as `genlayer-js-v1` for local tooling) |
| Next.js / React | 16.3.5 / 19.3.0 |

Chain id note: `genlayer-js` ships `localnet` as 61127 while `genlayer-py` uses 61999, and
`scripts/glsim.sh` runs the node on 61999 so the Python tests work. That override applies
to `localnet` only — see "Live testnet" above for why the console identifies every network
by name rather than by chain id, and verifies both against the node before signing.

The runner hash is pinned in the first line of both contracts. `test`, `latest` and
unversioned aliases are rejected by every GenLayer network, and the deploy script
verifies the pin rather than rewriting it: a stale v0.5 pin is refused by name.

The v0.5 hash `py-genlayer:1jb45aa8...` is recognised only so it can be refused.
Deploying it to Studio Next fails with `invalid_contract runner malformed` — the
validators unanimously reject the contract before any of its code runs.

---

## Scope and safety

This repository contains a **demo** lending protocol built solely to be protected in a
hackathon demonstration. It implements no exploit code, no attack primitives, and does
not interact with any real DeFi protocol. The `simulate_*` methods are owner-only and
only move the demo protocol's own reported telemetry into an anomalous-looking state;
they never corrupt its accounting.

---

## Next

- **Exercise the browser wallet path.** The only part of the system with no verification
  behind it at all.
- **Characterise validator variance at size** — `node scripts/demo-incident.mjs
  --network studio-next --scenario critical --repeat 20`. One observation of
  disagreement is proof that it happens, not a distribution. This is the only honest
  basis for revisiting `SEVERITY_TOLERANCE`.
- Understand the `sim_estimateTransactionFees` failure on Studio Next.
