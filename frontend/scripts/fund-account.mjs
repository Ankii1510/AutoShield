#!/usr/bin/env node
/**
 * Fund an account on a GenLayer Studio network.
 *
 * WHY. Studio Next (chain 61997) runs consensus v0.6, which charges fees —
 * the hackathon announcement says so explicitly ("includes the latest
 * features, including fees"). A fresh account there holds nothing, and the
 * public faucet at testnet-faucet.genlayer.foundation funds Bradbury and
 * Asimov, not chain 61997.
 *
 * Studio networks expose `sim_fundAccount(address, amount)` for exactly this.
 * genlayer-js ships a `fundAccount` helper for it but refuses any chain that
 * is not localnet, so this calls the RPC directly — the method is the SDK's
 * own, not an invented one.
 *
 *     node scripts/fund-account.mjs --network studio-next \
 *       --keystore ~/.genlayer/keystores/<name>.json --amount 100
 *
 * This only works on SIMULATED networks (localnet, studionet, studio-next,
 * studio-dev). A real testnet mints nothing on request, and pretending
 * otherwise would just produce a confusing error, so those are refused with
 * the faucet URL instead.
 */

import {
  NETWORKS,
  accountFor,
  chainFor,
  expectedChainId,
  resolvePrivateKey,
  rpcFor,
  verifyNetwork,
} from "./lib/genlayer.mjs";

const ONE_ATTO = 10n ** 18n;

const USAGE = [
  "Usage: node scripts/fund-account.mjs --network <name> [options]",
  "",
  `  --network <name>   ${Object.keys(NETWORKS).join(" | ")}`,
  "  --keystore <path>  GenLayer CLI account, with KEYSTORE_PASSWORD set",
  "  --amount <n>       GEN to request (default 100)",
  "  --wei <n>          request an exact wei amount instead",
  "  --address 0x...    fund this address instead of the keystore's own",
  "",
  "  Simulated networks only. Bradbury and Asimov use the public faucet:",
  "  https://testnet-faucet.genlayer.foundation/",
].join("\n");

function parseArgs(argv) {
  const out = {
    network: null,
    keystore: null,
    amount: 100,
    wei: null,
    address: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--network") out.network = argv[++i] ?? null;
    else if (arg === "--keystore") out.keystore = argv[++i] ?? null;
    else if (arg === "--amount") out.amount = Number(argv[++i]);
    else if (arg === "--wei") out.wei = argv[++i] ?? null;
    else if (arg === "--address") out.address = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else {
      throw new Error(
        `Unknown argument: ${arg}\n\n` +
          "If you ran this through `npm run`, npm may have swallowed the flag\n" +
          "names (it does on Windows). Run node directly.\n",
      );
    }
  }
  if (!out.help && (!Number.isFinite(out.amount) || out.amount <= 0)) {
    throw new Error("--amount must be a positive number");
  }
  return out;
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.json();
}

async function balanceOf(url, address) {
  const result = await rpc(url, "eth_getBalance", [address, "latest"]);
  if (typeof result?.result !== "string") return null;
  return BigInt(result.result);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const chain = chainFor(options.network);
  const url = rpcFor(options.network, chain);
  const chainId = expectedChainId(options.network, chain);

  if (!chain.isStudio) {
    throw new Error(
      `${options.network} is a real testnet — nothing mints tokens on request ` +
        "there. Claim from https://testnet-faucet.genlayer.foundation/ instead " +
        "(Cloudflare-gated, so it must be done in a browser).",
    );
  }

  const key = await resolvePrivateKey({ keystore: options.keystore });
  const account = accountFor(options.network, key);
  const target = options.address ?? account.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
    throw new Error(`Not a 20-byte address: ${target}`);
  }

  console.log(`network     ${options.network} (chain ${chainId})`);
  console.log(`rpc         ${url}`);
  console.log(`funding     ${target}`);
  await verifyNetwork(url, chainId, options.network);

  const before = await balanceOf(url, target);
  console.log(`balance     ${before ?? "unknown"} wei before`);

  // The RPC takes wei, not GEN: on the local sim `--amount 50` credited
  // exactly 50 wei, which would look like funding and then fail every
  // transaction. So GEN is converted here, and --wei stays available for
  // anyone who wants the raw unit.
  const requested = options.wei !== null
    ? BigInt(options.wei)
    : BigInt(Math.round(options.amount)) * ONE_ATTO;
  console.log(`requesting  ${requested} wei (~${requested / ONE_ATTO} GEN)`);

  const result = await rpc(url, "sim_fundAccount", [target, Number(requested)]);
  if (result.error) {
    throw new Error(
      `sim_fundAccount failed: ${JSON.stringify(result.error)}\n` +
        "If the method is not available on this network, ask in the GenLayer " +
        "community channels how accounts are funded on chain " +
        `${chainId}. Nothing else was attempted.`,
    );
  }

  // Funding is asynchronous on some nodes; poll briefly rather than claiming
  // success from the RPC returning without an error.
  let after = before;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    after = await balanceOf(url, target);
    if (after !== null && before !== null && after > before) break;
  }

  console.log(`balance     ${after ?? "unknown"} wei after`);
  if (after !== null && before !== null && after > before) {
    console.log(`funded      +${after - before} wei (~${(after - before) / ONE_ATTO} GEN)`);
    console.log("\nNext: node scripts/deploy-testnet.mjs --network " + options.network);
  } else {
    console.log(
      "\nThe call returned no error but the balance did not change. Do NOT treat " +
        "that as funded — re-run, or ask how chain " + chainId + " funds accounts.",
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nfund-account failed: ${error.message}`);
  process.exitCode = 1;
});
