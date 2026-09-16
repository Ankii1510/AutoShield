#!/usr/bin/env node
/**
 * Measure a network's maximum accepted per-transaction gas limit.
 *
 * WHY. Testnet Bradbury rejected an AutoShield deploy with
 * `-32602 ... gas limit too high` even though the estimate (27,382,350) was
 * well under the block gas limit (100,000,000). So the network enforces a
 * per-transaction ceiling somewhere below that, and nothing in the RPC, the
 * SDK or the published docs states what it is.
 *
 * Rather than guess a number and burn a round trip per guess, this measures
 * it: a binary search over the gas LIMIT of a trivial self-transfer.
 *
 * WHAT IT COSTS. Almost nothing. The gas limit is a ceiling, not a charge —
 * an accepted probe executes a plain 21,000-gas transfer to the sender's own
 * address, and a rejected probe never enters a block at all. Roughly a dozen
 * transfers in total. It moves no value: every transfer is self-to-self with
 * value 0.
 *
 *     node scripts/probe-gas-cap.mjs --network testnet-bradbury \
 *       --keystore ~/.genlayer/keystores/<name>.json
 *
 * The answer tells us something that matters beyond this script: whether
 * AutoShield's contracts can be deployed to this network as they stand.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NETWORKS,
  accountFor,
  clientFor,
  chainFor,
  expectedChainId,
  resolvePrivateKey,
  rpcFor,
  verifyNetwork,
} from "./lib/genlayer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = [
  "Usage: node scripts/probe-gas-cap.mjs --network <name> [--keystore <path>]",
  "",
  `  --network <name>   ${Object.keys(NETWORKS).join(" | ")}`,
  "  --keystore <path>  GenLayer CLI account, with KEYSTORE_PASSWORD set",
  "  --ceiling <n>      upper bound to search from (default: block gas limit)",
  "",
  "  Signing account: TESTNET_PRIVATE_KEY, or --keystore + KEYSTORE_PASSWORD.",
  "  Sends a handful of zero-value self-transfers. Moves no funds.",
].join("\n");

function parseArgs(argv) {
  const out = { network: null, keystore: null, ceiling: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--network") out.network = argv[++i] ?? null;
    else if (arg === "--keystore") out.keystore = argv[++i] ?? null;
    else if (arg === "--ceiling") out.ceiling = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else {
      throw new Error(
        `Unknown argument: ${arg}\n\n` +
          "If you ran this through `npm run`, npm may have swallowed the flag\n" +
          "names (it does on Windows). Run node directly.\n",
      );
    }
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const chain = chainFor(options.network);
  const url = rpcFor(options.network, chain);
  const chainId = expectedChainId(options.network, chain);

  // localnet and studionet are simulators, not EVM chains: they do not accept
  // raw signed transfers at all, so there is no gas ceiling to measure and the
  // probe would fail with a confusing decoding error instead of a result.
  if (chain.isStudio) {
    throw new Error(
      `${options.network} is a simulated network with no EVM transaction layer, ` +
        "so it has no per-transaction gas ceiling to measure. Run this against " +
        "testnet-bradbury or testnet-asimov.",
    );
  }

  const key = await resolvePrivateKey({ keystore: options.keystore });
  const account = accountFor(options.network, key);
  const client = clientFor(options.network, { ...chain, id: chainId }, account);

  console.log(`network     ${options.network} (chain ${chainId})`);
  console.log(`rpc         ${url}`);
  console.log(`account     ${account.address}`);
  await verifyNetwork(url, chainId, options.network);

  const block = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
  const blockGasLimit = BigInt(block?.result?.gasLimit ?? "0x0");
  console.log(`block limit ${blockGasLimit}`);

  const gasPriceHex = (await rpc(url, "eth_gasPrice")).result ?? "0x0";
  const gasPrice = BigInt(gasPriceHex);
  let nonce = Number(
    (await rpc(url, "eth_getTransactionCount", [account.address, "pending"])).result ?? "0x0",
  );

  /**
   * Try one gas limit. Returns true if the node ACCEPTS the transaction.
   *
   * Only the send is under test. A rejection is the answer we are looking for,
   * not an error, so it is caught and reported as `false`.
   */
  async function accepted(gasLimit) {
    const signed = await account.signTransaction({
      to: account.address,
      value: 0n,
      gas: gasLimit,
      gasPrice,
      nonce,
      chainId,
      type: "legacy",
    });
    const result = await rpc(url, "eth_sendRawTransaction", [signed]);
    if (result.error) {
      const message = String(result.error.message ?? "");
      if (/gas limit too high|exceeds/i.test(message)) return false;
      // Anything else is a real problem, not a measurement.
      throw new Error(`Probe failed at gas ${gasLimit}: ${message}`);
    }
    nonce += 1; // The transaction entered the pool, so the nonce is consumed.
    return true;
  }

  let low = 21000n; // A plain transfer; must always be accepted.
  let high = options.ceiling ? BigInt(options.ceiling) : blockGasLimit;

  console.log(`\nprobing between ${low} and ${high} ...`);

  if (await accepted(high)) {
    console.log(`\nThe node accepted the full ${high}. No lower cap found.`);
    return;
  }
  console.log(`  ${high} rejected, as expected — searching downward`);

  // Binary search to within 1% of the true ceiling: enough to act on, and
  // cheaper than pinning down the exact gas unit.
  while (high - low > low / 100n + 1n) {
    const mid = (low + high) / 2n;
    const ok = await accepted(mid);
    console.log(`  ${mid} ${ok ? "accepted" : "rejected"}`);
    if (ok) low = mid;
    else high = mid;
  }

  console.log(`\nMaximum accepted gas limit: about ${low}`);
  console.log(`  (block gas limit is ${blockGasLimit}, so the cap is per-transaction)`);
  console.log("\nUse it with either script:");
  console.log(`  $env:AUTOSHIELD_MAX_GAS = "${low}"`);
  console.log(
    "\nIf AutoShield's deploy estimate is ABOVE this number, the contracts do not\n" +
      "fit on this network as they stand, and the honest fix is to make them\n" +
      "smaller — not to clamp the limit below what execution actually needs,\n" +
      "which would just fail as out-of-gas instead.",
  );
}

main().catch((error) => {
  console.error(`\nprobe-gas-cap failed: ${error.message}`);
  process.exitCode = 1;
});
