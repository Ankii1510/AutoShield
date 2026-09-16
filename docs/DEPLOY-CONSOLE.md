# Hosting the console, and verifying it

The contracts are already live on Studio Next. This document covers the one
remaining piece: putting the Security Operations Console on a public URL, and
then checking that the hosted site is really talking to the chain rather than
falling back to Demo mode.

Do these in order. Step 3 is the one that actually matters — a green build that
quietly serves Demo mode looks identical to a working deployment from the
outside, and that is exactly the failure this document exists to prevent.

---

## What is being hosted

Only `frontend/`. It is a browser client for contracts that already exist on
chain, so there is no server, no database and no secret involved:

- every value the browser needs is a `NEXT_PUBLIC_*` variable, and those are
  compiled into the JavaScript bundle by design — they are public addresses and
  a public RPC URL;
- `studio-next.genlayer.com` answers with `access-control-allow-origin: *`, so
  the page can call the chain directly from any origin with no proxy;
- **no private key is involved in hosting.** The deploy and demo scripts sign
  transactions, and `.vercelignore` keeps `scripts/` off the host entirely.

If you are ever asked to add a private key to a hosting environment variable for
this project, something has gone wrong. Nothing here needs one.

---

## 1. Deploy to Vercel

From the repository root:

```bash
cd frontend
npx vercel login          # opens a browser once
npx vercel link           # accept the defaults; creates .vercel/
```

Then deploy, passing the three public values as **build** environment variables.
They have to be present at build time, not runtime: Next.js inlines
`NEXT_PUBLIC_*` into the bundle while compiling, so setting them afterwards
changes nothing until the next build.

```bash
npx vercel deploy --prod \
  --build-env NEXT_PUBLIC_GENLAYER_NETWORK=studio-next \
  --build-env NEXT_PUBLIC_PROTOCOL_ADDRESS=0x054be2be73d15DB1B13d836F4045612AB65c685A \
  --build-env NEXT_PUBLIC_AUTOSHIELD_ADDRESS=0x7834967C394e6831c34710134afc0BfFFD9eeA8E
```

Vercel prints a `https://<project>-<hash>.vercel.app` URL. That is the link for
the submission.

To make the values stick for every future deploy (so a later `vercel deploy
--prod` with no flags still works), add them to the project once:

```bash
npx vercel env add NEXT_PUBLIC_GENLAYER_NETWORK production
npx vercel env add NEXT_PUBLIC_PROTOCOL_ADDRESS production
npx vercel env add NEXT_PUBLIC_AUTOSHIELD_ADDRESS production
```

### If the addresses ever change

Redeploying the contracts rewrites `deployments/studio-next.json` and
`frontend/.env.local`. Take the two addresses from either file, update the
Vercel env vars, and deploy again. The console reads addresses from the
environment only — it never hardcodes one.

---

## 2. Confirm the build used the right values

Before opening the site, confirm the addresses actually made it into the bundle.
This is a five-second check that catches the single most likely mistake:

```bash
curl -s https://<your-url>.vercel.app | grep -o 'chunks/[^"]*\.js' | head -20
```

Or simply proceed to step 3, which tests the same thing more directly.

---

## 3. Verify the hosted console is on chain, not in Demo mode

Open the URL in a normal browser window.

**The one test that matters:** the header must NOT say "Simulated — no chain".
Demo mode is the fallback when no addresses are configured, and it renders a
complete, convincing incident flow with no chain behind it. It is labelled
everywhere it appears, which is the point — but on a submission URL it would be
the wrong thing to show.

Work down this list. Each line is either true or the deployment is not done.

| # | Check | Pass looks like |
|---|---|---|
| 1 | Header network badge | `studio-next` / chain `61997` — **not** "Simulated — no chain" |
| 2 | Wrong-network banner | absent (it appears only if the node reports a different chain id) |
| 3 | Protected protocol card | shows address `0x054be2be…685A` and a mode of `NORMAL` or `HALTED` |
| 4 | AutoShield address | `0x7834967C…eA8E` |
| 5 | Incident list | contains `INC-1` and `INC-2` — these are real on-chain incidents |
| 6 | Open `INC-2` | severity **82**, signals `price_manipulation` and `liquidity_drain`, level **HALT** |
| 7 | "Why this decision?" panel | the contract's `preview_level` agrees with the stored level (no disagreement notice) |
| 8 | Validator panel on `INC-2` | rows carry real votes and are **not** marked `Simulated` |
| 9 | Open `INC-1` | severity **32**, no signals, level **SAFE**, and the votes include **disagree** |
| 10 | Browser devtools → Network | requests go to `studio-next.genlayer.com/api` and return 200 |
| 11 | Devtools → Console | no red errors |

If items 1–5 pass but 6–9 show nothing, the site is reading the chain but the
incidents have expired or been cleared — run a fresh incident (see below) and
reload.

### Producing a fresh incident against the hosted site

The console polls chain state, so you can drive it from a terminal and watch the
hosted page react with nothing connected to it:

```bash
cd frontend
export TESTNET_PRIVATE_KEY=0x...      # dedicated testnet key, shell only
node scripts/demo-incident.mjs --network studio-next --scenario critical
```

Reload the hosted page: a new incident appears, the protocol card flips to
`HALTED`, and the countdown starts. The response expires on its own.

---

## 4. Verify the browser wallet path

**This is the only part of the system with no verification behind it at all.**
It is wired and it typechecks; no MetaMask Snap session has ever been run. If it
turns out to be broken, that is a discovery, not a regression — and it is better
to find out before a demo than during one.

Requirements: MetaMask installed, and the deployment's operator role held by the
address you connect. The current deployment's operator is the deployer,
`0x83d074B194aa2AD828729F20b3988ac70e73161f`. To give a browser wallet those
roles instead, redeploy with `--operator 0xYourWalletAddress`.

| # | Check | Pass looks like |
|---|---|---|
| 1 | Press **Connect wallet** | MetaMask prompts to install/approve the GenLayer Snap |
| 2 | Approve | header shows the connected address and chain `61997` |
| 3 | "Your permissions" panel | lists what that address may do, read from the contract |
| 4 | An action the wallet may do | signs, and the console reports success only after the node reports a successful execution result |
| 5 | An owner-only action (`clear_response`) from a non-owner wallet | the console shows the contract's **rejection**, rather than hiding the control |

Item 5 is a feature, not a bug: neither contract has an ownership-transfer path,
so the owner-only escape hatches stay with the deployer key.

**If the wallet path does not work, the demo is unaffected.** AutoShield is an
autonomous system — in production the thing that files an incident is a
monitoring service, not a person clicking a button — so the whole flow runs from
the command line, and the console is a read-only window onto it. Say that
plainly rather than working around it.

---

## What to record as the result

Whatever you find, write it down honestly:

- the public URL;
- which checklist items passed;
- anything that failed, and whether it blocks the demo.

A hosted console that reads the chain correctly and has an unverified wallet
button is a good, defensible result. A hosted console silently serving Demo mode
is not, however green the build log looked.
