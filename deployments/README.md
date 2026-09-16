# Deployment records

One JSON file per network, written by `frontend/scripts/deploy-testnet.mjs`
(`deployments/<network>.json`). They are committed on purpose: a deployment
record is how anyone can check a later claim about what was deployed, where,
and what the network said about it at the time.

**Current deployment: `studio-next.json`** — GenLayer Studio Next, chain 61997,
consensus v0.6, deployed 2026-09-15.

    DemoLendingProtocol  0x054be2be73d15DB1B13d836F4045612AB65c685A
    AutoShield           0x7834967C394e6831c34710134afc0BfFFD9eeA8E

`studio-next-demo-*.json` records are incident runs, one file per run, named by
timestamp. `localnet-demo-*.json` came from a local sim node.

**Superseded records are kept rather than deleted**, because a record that only
ever shows successes is not evidence of anything. Two files refer to a previous
deployment at `0xdBd33764...` / `0xb92DD5fF...`, which was built from the
dual-generation contract source before the full v0.6 migration:

- `studio-next-demo-2026-09-15T11-06-*.json` — an incident run against it;
- `last-failure-studio-next.json` — an `execute_response` that the network
  rejected with `fee no_matching_allocation`, written automatically by the
  deploy/demo scripts when a transaction fails.

Neither address is live. Use `studio-next.json` for anything current.

## What goes in a record

Public information only:

- network name, chain id, RPC endpoint, explorer URL, consensus contract
- deployment timestamp, deployer address, operator address
- both contract addresses
- every transaction hash, with an explorer link
- for each transaction, what the network itself reported about consensus:
  status, execution result, finality, round count, vote tally and per-validator
  execution results, recorded verbatim
- the frontend configuration the deployment implies
- the GenVM runner pin the contracts were deployed with

The consensus block is recorded raw rather than summarised so that any later
statement about validator participation can be checked against what the network
actually returned, instead of being taken on trust.

## What must never go in a record

Private keys, mnemonics, keystore contents, API keys, faucet credentials, or
anything else that grants control of an account. The deploy script reads its key
from `TESTNET_PRIVATE_KEY` in the environment, never writes it anywhere, and
never prints it — not even a prefix, since a partial key alongside a known
address narrows the search far more than it appears to.

Use a dedicated testnet account that holds nothing of value.
