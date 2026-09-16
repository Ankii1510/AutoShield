#!/usr/bin/env node
/**
 * Deploy AutoShield + DemoLendingProtocol to a local GenLayer Sim node and
 * write the resulting addresses into `frontend/.env.local`.
 *
 * Run it from the `frontend/` directory:
 *
 *     ../scripts/glsim.sh restart 5
 *     npm run deploy:local
 *     npm run dev
 *
 * WHAT THIS SCRIPT IS FOR. The console needs two contract addresses before it
 * can leave Demo mode. This is the only supported way to produce them locally.
 *
 * KEY HANDLING. The deployer key is ephemeral by default: a fresh key is
 * generated per run, used to sign the deployment, printed for reference and
 * then forgotten. It is never written into `.env.local`, because every
 * NEXT_PUBLIC_* value is compiled into the browser bundle and is world
 * readable. Pass AUTOSHIELD_DEPLOYER_KEY in the environment to reuse one
 * across runs; it stays in the shell, never on disk.
 *
 * OWNERSHIP. Whoever deploys is the owner of both contracts, and neither
 * contract has an ownership transfer path (deliberately: guard rotation is
 * the only privileged rotation either contract supports). So a browser wallet
 * can report incidents and adjudicate — those roles are assignable — but the
 * owner-only escape hatches (clear_response, set_paused) belong to the
 * deployer key and will honestly fail from the browser. Pass --operator to
 * grant the assignable roles to the address your wallet will connect with:
 *
 *     npm run deploy:local -- --operator 0xYourWalletAddress
 *
 * Without --operator, the deployer holds every role and chain-mode writes from
 * the browser will be rejected by the contracts, which is the correct
 * behaviour, not a bug to work around.
 *
 * GenLayerJS APIs used here, all verified against genlayer-js@1.1.8's own type
 * declarations: createClient, createAccount, generatePrivateKey,
 * client.deployContract, client.writeContract, client.readContract,
 * client.waitForTransactionReceipt, CalldataAddress, TransactionStatus.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned to the v0.5 SDK: the local GenLayer Sim runs the v0.5 stack, and a
// v2 client cannot talk to it at all (see scripts/lib/genlayer.mjs).
import {
  createAccount,
  createClient,
  generatePrivateKey,
} from "genlayer-js-v1";
import { localnet } from "genlayer-js-v1/chains";
import { CalldataAddress, TransactionStatus } from "genlayer-js-v1/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "..");
const CONTRACTS = resolve(FRONTEND, "..", "contracts");

const RPC = process.env.GLSIM_RPC ?? "http://127.0.0.1:4000/api";
// glsim.sh starts the node on 61999 so genlayer-py's own `localnet` matches.
// genlayer-js ships `localnet` as 61127, so the id is configuration here too.
const CHAIN_ID = Number(process.env.GLSIM_CHAIN_ID ?? 61999);

const ONE_ATTO = 10n ** 18n;

/** Seed liquidity, so the console shows a protocol with something to protect. */
const SEED = [
  { deposit: 900_000n, borrow: 400_000n },
  { deposit: 250_000n, borrow: 150_000n },
  { deposit: 100_000n, borrow: 60_000n },
];

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { operator: null, noSeed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--operator") {
      out.operator = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--no-seed") {
      out.noSeed = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (out.operator !== null && !/^0x[0-9a-fA-F]{40}$/.test(out.operator)) {
    throw new Error(`--operator must be a 20-byte hex address, got: ${out.operator}`);
  }
  return out;
}

// ------------------------------------------------------------------ helpers

/**
 * Hex address -> CalldataAddress.
 *
 * genlayer-js's CalldataAddress constructor takes 20 raw bytes and rejects a
 * hex string with "invalid address length", unlike its Python counterpart.
 * This mirrors `lib/genlayer/client.ts#toCalldataAddress`; the script cannot
 * import that module because it is TypeScript under the Next.js path aliases.
 */
function addr(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 40 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Not a 20-byte address: ${hex}`);
  }
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new CalldataAddress(bytes);
}

function leaderReceipt(receipt) {
  const leaders = receipt?.consensus_data?.leader_receipt;
  return Array.isArray(leaders) && leaders.length > 0 ? leaders[0] : null;
}

/**
 * Assert that the CONTRACT executed, not merely that the network settled.
 *
 * A GenLayer transaction can reach ACCEPTED/FINALIZED with the contract having
 * reverted, in which case no state changed at all. Treating the lifecycle
 * status as success is exactly the mistake the console refuses to make in its
 * UI, so the deploy script does not make it either.
 */
function assertExecuted(receipt, what) {
  const leader = leaderReceipt(receipt);
  const result = leader?.execution_result ?? receipt?.txExecutionResultName ?? null;
  if (result !== "SUCCESS") {
    const stderr = leader?.genvm_result?.stderr ?? leader?.error ?? "";
    throw new Error(`${what} failed (${result ?? "no result"}): ${String(stderr).slice(0, 400)}`);
  }
  return receipt;
}

function contractAddressOf(receipt) {
  const decoded = receipt?.txDataDecoded;
  const candidates = [
    decoded?.contractAddress,
    receipt?.data?.contract_address,
    receipt?.to_address,
    receipt?.recipient,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]{40}$/.test(candidate)) {
      return candidate;
    }
  }
  throw new Error("Deploy receipt carried no contract address");
}

function chain() {
  return {
    ...localnet,
    id: CHAIN_ID,
    rpcUrls: { ...localnet.rpcUrls, default: { http: [RPC] } },
  };
}

function clientFor(privateKey) {
  const account = createAccount(privateKey);
  return { client: createClient({ chain: chain(), account }), account };
}

async function settled(client, hash) {
  return client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.FINALIZED,
    interval: 1000,
    retries: 120,
  });
}

async function send(client, address, functionName, args, what) {
  const hash = await client.writeContract({
    address,
    functionName,
    args,
    value: 0n,
  });
  return assertExecuted(await settled(client, hash), what);
}

// --------------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        "Usage: npm run deploy:local -- [--operator 0x...] [--no-seed]",
        "",
        "  --operator 0x...  grant reporter + evaluator to this address",
        "                    (the address your browser wallet connects with)",
        "  --no-seed         deploy only; do not create demo deposits",
        "",
        "  GLSIM_RPC                 default http://127.0.0.1:4000/api",
        "  GLSIM_CHAIN_ID            default 61999",
        "  AUTOSHIELD_DEPLOYER_KEY   reuse a deployer key instead of generating one",
      ].join("\n"),
    );
    return;
  }

  const deployerKey = process.env.AUTOSHIELD_DEPLOYER_KEY ?? generatePrivateKey();
  const { client, account: deployer } = clientFor(deployerKey);

  console.log(`RPC          ${RPC}`);
  console.log(`chain id     ${CHAIN_ID}`);
  console.log(`deployer     ${deployer.address}`);

  // Fail fast and clearly if there is no node, rather than timing out inside
  // the SDK with an opaque error.
  try {
    const probe = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = await probe.json();
    const reported = Number.parseInt(String(body.result), 16);
    if (Number.isFinite(reported) && reported !== CHAIN_ID) {
      console.warn(
        `WARNING: node reports chain id ${reported}, this script is configured for ${CHAIN_ID}.`,
      );
    }
  } catch (error) {
    throw new Error(
      `No GenLayer node reachable at ${RPC} (${error.message}). ` +
        "Start one with: ../scripts/glsim.sh restart 5",
    );
  }

  const protocolCode = await readFile(resolve(CONTRACTS, "demo_lending.py"), "utf8");
  const shieldCode = await readFile(resolve(CONTRACTS, "autoshield.py"), "utf8");

  // ---- 1. the protected protocol ---------------------------------------
  console.log("\ndeploying DemoLendingProtocol ...");
  const protocolHash = await client.deployContract({
    code: protocolCode,
    args: [ONE_ATTO],
  });
  const protocolReceipt = assertExecuted(
    await settled(client, protocolHash),
    "DemoLendingProtocol deploy",
  );
  const protocolAddress = contractAddressOf(protocolReceipt);
  console.log(`  ${protocolAddress}`);

  // ---- 2. the guard -----------------------------------------------------
  // The evaluator starts as the deployer and is reassigned below if an
  // operator was named; the constructor rejects the zero address.
  console.log("deploying AutoShield ...");
  const shieldHash = await client.deployContract({
    code: shieldCode,
    args: [addr(protocolAddress), addr(deployer.address)],
  });
  const shieldReceipt = assertExecuted(
    await settled(client, shieldHash),
    "AutoShield deploy",
  );
  const shieldAddress = contractAddressOf(shieldReceipt);
  console.log(`  ${shieldAddress}`);

  // ---- 3. wiring --------------------------------------------------------
  // One-shot genesis wiring: the protocol will accept a guard exactly once,
  // and every later rotation goes through propose/accept with a timelock.
  console.log("\nwiring guard and roles ...");
  await send(client, protocolAddress, "set_initial_guard", [addr(shieldAddress)],
    "set_initial_guard");

  const operator = options.operator ?? deployer.address;
  await send(client, shieldAddress, "set_reporter", [addr(operator), true], "set_reporter");
  if (options.operator) {
    await send(client, shieldAddress, "set_evaluator", [addr(operator)], "set_evaluator");
  }
  console.log(`  reporter + evaluator: ${operator}`);

  // ---- 4. seed liquidity ------------------------------------------------
  if (!options.noSeed) {
    console.log("\nseeding demo liquidity ...");
    for (const [index, position] of SEED.entries()) {
      const userKey = generatePrivateKey();
      const { client: userClient, account: user } = clientFor(userKey);

      await send(client, protocolAddress, "mint_demo_balance",
        [addr(user.address), position.deposit * ONE_ATTO], "mint_demo_balance");
      await send(userClient, protocolAddress, "deposit",
        [position.deposit * ONE_ATTO], "deposit");
      if (position.borrow > 0n) {
        await send(userClient, protocolAddress, "borrow",
          [position.borrow * ONE_ATTO], "borrow");
      }
      console.log(
        `  account ${index + 1}: deposited ${position.deposit}, borrowed ${position.borrow}`,
      );
    }
  }

  // ---- 5. verify by reading the chain back ------------------------------
  const status = await client.readContract({
    address: protocolAddress,
    functionName: "get_status",
    args: [],
  });
  const telemetry = await client.readContract({
    address: protocolAddress,
    functionName: "telemetry",
    args: [],
  });
  const config = await client.readContract({
    address: shieldAddress,
    functionName: "get_config",
    args: [],
  });

  console.log("\nverified on chain:");
  console.log(`  protocol mode      ${status.mode}`);
  console.log(`  total deposits     ${BigInt(telemetry.total_deposits_atto) / ONE_ATTO}`);
  console.log(`  total borrowed     ${BigInt(telemetry.total_borrowed_atto) / ONE_ATTO}`);
  console.log(`  guard on protocol  ${status.guard_address ?? "(see get_status)"}`);
  console.log(`  shield protects    ${config.protocol_address}`);
  console.log(`  shield evaluator   ${config.evaluator}`);

  // ---- 6. write .env.local ---------------------------------------------
  const envPath = resolve(FRONTEND, ".env.local");
  const contents = [
    "# Written by scripts/deploy-local.mjs. Safe to commit? NO -- it is",
    "# environment-specific, and .gitignore already excludes it.",
    "# Nothing secret is here: these are public addresses, and every",
    "# NEXT_PUBLIC_* value ends up in the browser bundle. Never add a key.",
    "# The network NAME is the identity. localnet is the only network whose",
    "# endpoint and chain id may be overridden by the two lines below.",
    "NEXT_PUBLIC_GENLAYER_NETWORK=localnet",
    `NEXT_PUBLIC_GENLAYER_RPC=${RPC}`,
    `NEXT_PUBLIC_GENLAYER_CHAIN_ID=${CHAIN_ID}`,
    `NEXT_PUBLIC_PROTOCOL_ADDRESS=${protocolAddress}`,
    `NEXT_PUBLIC_AUTOSHIELD_ADDRESS=${shieldAddress}`,
    "",
  ].join("\n");
  await writeFile(envPath, contents, "utf8");
  console.log(`\nwrote ${envPath}`);

  if (!options.operator) {
    console.log(
      "\nNOTE: no --operator was given, so the ephemeral deployer key holds every\n" +
        "role. A browser wallet will be able to read the chain but its writes will\n" +
        "be rejected by the contracts. Re-run with --operator <your wallet address>\n" +
        "to drive chain mode from the browser.",
    );
  }
  console.log("\nNext: npm run dev");
}

main().catch((error) => {
  console.error(`\ndeploy-local failed: ${error.message}`);
  process.exitCode = 1;
});
