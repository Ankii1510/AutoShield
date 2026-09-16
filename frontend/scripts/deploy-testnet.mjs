#!/usr/bin/env node
/**
 * Deploy AutoShield + DemoLendingProtocol to a public GenLayer TESTNET.
 *
 * This is deliberately a separate script from `deploy-local.mjs`, which stays
 * the fast path for local development. A public deployment is not the same
 * job: it costs real testnet GEN, it cannot be undone by restarting a node,
 * and getting the network wrong means signing against a chain nobody chose.
 * So this script is slower, louder, and refuses far more often.
 *
 *     export TESTNET_PRIVATE_KEY=0x...          # a DEDICATED testnet key
 *     node scripts/deploy-testnet.mjs --network testnet-bradbury --operator 0xYourWallet
 *
 * SECRETS. The key is read from the environment and nowhere else. It is never
 * written to a file, never included in the deployment record, and never
 * printed — not even partially, since a prefix plus a public address narrows
 * a key far more than people expect. Use an account that holds nothing but
 * testnet GEN.
 *
 * MAINNET. There is no mainnet path here. The allowed networks are listed
 * below and anything else is refused.
 *
 * WHAT "SUCCESS" MEANS HERE. Every transaction must reach FINALIZED *and*
 * report `execution_result === "SUCCESS"`. On GenLayer a transaction can
 * finalize with the contract having reverted, in which case no state changed
 * and, for a deploy, no contract exists. Submission is not success, and
 * neither is finalization on its own.
 *
 * GenLayerJS APIs used, all verified against genlayer-js@1.1.8's own type
 * declarations: createClient, createAccount, client.getBalance (viem
 * PublicActions, spread into GenLayerClient), client.deployContract,
 * client.readContract, client.writeContract, client.waitForTransactionReceipt,
 * CalldataAddress (genlayer-js/types, 20 raw bytes), TransactionStatus.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEPLOYABLE,
  accountFor,
  clientFor,
  quoteFees,
  quoteWriteFees,
  sdkFor,
  ONE_ATTO,
  TransactionStatus,
  addrFor,
  assertFinalizedAndExecuted,
  failureReport,
  chainFor,
  clampGasToBlockLimit,
  consensusFacts,
  contractAddressOf,
  expectedChainId,
  resolvePrivateKey,
  rpcFor,
  verifyNetwork,
  verifyRunnerPin,
} from "./lib/genlayer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "..");
const ROOT = resolve(FRONTEND, "..");
const CONTRACTS = resolve(ROOT, "contracts");
const DEPLOYMENTS = resolve(ROOT, "deployments");

/** Seed liquidity, so the console has a protocol with something to protect. */
const SEED = [
  { deposit: 900_000n, borrow: 400_000n },
  { deposit: 250_000n, borrow: 150_000n },
];

// ---------------------------------------------------------------- arguments

/**
 * Explain the npm-on-Windows argument-stripping trap.
 *
 * `npm run <script> -- --network x` does not behave the same everywhere. On
 * Windows npm treats unrecognised `--flag value` pairs as its OWN config and
 * consumes them, so the script receives only the bare values and reports an
 * unknown argument for something the user clearly typed correctly. Guessing
 * that a stray positional was meant to be `--network` would be worse than
 * failing, so instead this says exactly what happened and what to run.
 */
function npmStrippedArgs(arg) {
  return new Error(
    `Unknown argument: ${arg}\n\n` +
      "If you ran this through `npm run`, npm probably swallowed the flag names:\n" +
      "on Windows it treats unrecognised `--flag value` pairs as its own config, so\n" +
      "the script only receives the values. Run node directly instead:\n\n" +
      "  node scripts/deploy-testnet.mjs --network <name> [other options]\n",
  );
}

function parseArgs(argv) {
  const out = {
    network: null,
    operator: null,
    keystore: null,
    noSeed: false,
    estimateOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--network") {
      out.network = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--keystore") {
      out.keystore = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--operator") {
      out.operator = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--no-seed") {
      out.noSeed = true;
    } else if (arg === "--estimate-only") {
      out.estimateOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw npmStrippedArgs(arg);
    }
  }
  return out;
}

const USAGE = [
  "Usage: node scripts/deploy-testnet.mjs --network <name> [options]",
  "",
  `  --network <name>   required, one of: ${DEPLOYABLE.join(", ")}`,
  "  --keystore <path>  use a GenLayer CLI account instead of a raw key.",
  "                     Point this at ~/.genlayer/keystores/<name>.json and set",
  "                     KEYSTORE_PASSWORD in the environment.",
  "  --operator 0x...   address to grant the reporter + evaluator roles (your wallet)",
  "  --no-seed          deploy and wire only; create no demo deposits",
  "  --estimate-only    report the gas each deploy needs and STOP. Sends nothing.",
  "",
  "  Exactly one signing source is required:",
  "    TESTNET_PRIVATE_KEY   a raw 0x + 64 hex key, or",
  "    --keystore + KEYSTORE_PASSWORD",
  "",
  "  Use a DEDICATED testnet account. Never one that controls anything of value.",
].join("\n");

// ------------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  // ---- 1. network, chosen by name and never inferred -------------------
  if (!options.network) {
    throw new Error(`--network is required.\n\n${USAGE}`);
  }
  const chain = chainFor(options.network, { allow: DEPLOYABLE });
  const rpc = rpcFor(options.network, chain);
  const explorer = chain.blockExplorers?.default?.url ?? null;

  // ---- 2. account: raw key from the environment, or a CLI keystore ------
  const key = await resolvePrivateKey({ keystore: options.keystore });
  const account = accountFor(options.network, key);
  const keySource = options.keystore
    ? `keystore ${options.keystore}`
    : "TESTNET_PRIVATE_KEY";
  const client = clientFor(options.network, chain, account);

  if (options.operator !== null && !/^0x[0-9a-fA-F]{40}$/.test(options.operator)) {
    throw new Error(`--operator must be a 20-byte hex address, got: ${options.operator}`);
  }

  console.log(`network       ${options.network} (${chain.name})`);
  console.log(`chain id      ${chain.id}`);
  console.log(`rpc           ${rpc}`);
  console.log(`explorer      ${explorer ?? "(none published)"}`);
  console.log(`deployer      ${account.address}`);
  console.log(`key source    ${keySource} (never shown, never stored)`);
  console.log(`sdk           genlayer-js ${sdkFor(options.network)} (consensus ` +
    `${sdkFor(options.network) === "v2" ? "v0.6" : "v0.5"})`);

  // ---- 3. verify the node before signing anything ----------------------
  // Bradbury and Asimov both report chain 4221, so the id alone cannot tell
  // them apart; the endpoint is what distinguishes them, and it comes from
  // the named chain definition rather than from any environment variable.
  const reportedId = await verifyNetwork(
    rpc,
    expectedChainId(options.network, chain),
    options.network,
  );
  console.log(`verified      node reports chain ${reportedId}`);

  // genlayer-js uses its gas estimate verbatim and exposes no way to cap it;
  // these contracts are large enough that Bradbury rejects the estimate with
  // "gas limit too high". Clamp to the network's own block gas limit.
  // Contracts carry a GenVM runner pin in their first line, and it differs
  // between consensus generations. Deploying the v0.5 pin to a v0.6 network
  // fails with "invalid_contract runner malformed". Since the v0.6 migration
  // the committed pin is the only correct one, so this VERIFIES it and
  // refuses anything else rather than rewriting the source on the way out.
  const protocolPinned = verifyRunnerPin(
    options.network,
    await readFile(resolve(CONTRACTS, "demo_lending.py"), "utf8"),
  );
  const shieldPinned = verifyRunnerPin(
    options.network,
    await readFile(resolve(CONTRACTS, "autoshield.py"), "utf8"),
  );
  // Send the contract as BYTES, not a string.
  //
  // `deployContract` accepts `string | Uint8Array`, and GenLayer's own v2-dev
  // boilerplate passes `new Uint8Array(readFileSync(path))`. Passing a string
  // to a v0.6 network is what produced `contract_error: invalid_contract
  // runner malformed` — the validators unanimously rejected the contract
  // before any of its code ran, so this is about how the payload is framed,
  // not about the runner hash or the contract itself.
  const encode = (text) => new TextEncoder().encode(text);
  const protocolCodeForEstimate = encode(protocolPinned.source);
  const shieldCodeForEstimate = encode(shieldPinned.source);

  console.log(`runner        ${protocolPinned.pin}`);

  const gas = await clampGasToBlockLimit(rpc);
  console.log(
    `gas ceiling   ${gas.cap ?? "unknown"}` +
      (gas.blockGasLimit ? ` (block limit ${gas.blockGasLimit})` : ""),
  );

  // ---- 4. funding ------------------------------------------------------
  let balance = null;
  try {
    balance = await client.getBalance({ address: account.address });
  } catch {
    balance = null; // Not fatal: studionet is gasless and may not implement it.
  }
  if (balance !== null) {
    console.log(`balance       ${balance} wei (${balance / ONE_ATTO} GEN)`);
    if (balance === 0n) {
      // How an account gets funded depends on what kind of network this is.
      // Pointing someone at the public faucet for a chain it does not serve
      // wastes their time, which is exactly what this used to do for
      // studio-next.
      const howToFund = chain.isStudio
        ? `node scripts/fund-account.mjs --network ${options.network} ` +
          "--keystore <path>   (simulated network: it mints on request)"
        : "https://testnet-faucet.genlayer.foundation/ (Cloudflare-gated, so it " +
          "must be claimed manually in a browser)";
      throw new Error(
        `${account.address} holds 0 GEN on ${options.network}, so every ` +
          `transaction would fail. Fund it:\n\n  ${howToFund}\n\n` +
          "then re-run. Nothing was signed.",
      );
    }
  }

  // ---- 4b. estimate-only ------------------------------------------------
  //
  // Bradbury caps a single transaction at about 2^24 gas, which is less than
  // deploying a contract of this size costs. Knowing the exact requirement
  // matters more than guessing at it, and it can be learned for free: let the
  // deploy path run as far as the gas estimate, then refuse to broadcast.
  //
  // The refusal is enforced at the transport, so "nothing was sent" is a
  // property of the code rather than a promise.
  if (options.estimateOnly) {
    const contracts = [
      ["DemoLendingProtocol", protocolCodeForEstimate, [ONE_ATTO]],
      [
        "AutoShield",
        shieldCodeForEstimate,
        [addrFor(options.network, account.address), addrFor(options.network, account.address)],
      ],
    ];

    const realFetch = globalThis.fetch;
    const results = [];

    for (const [name, code, deployArgs] of contracts) {
      let estimate = null;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input?.url;
        if (url === rpc && init?.body) {
          let payload = null;
          try {
            payload = JSON.parse(init.body);
          } catch {
            payload = null;
          }
          if (payload?.method === "eth_sendRawTransaction") {
            throw new Error("__ESTIMATE_ONLY__");
          }
          if (payload?.method === "eth_estimateGas") {
            const response = await realFetch(input, init);
            try {
              const body = await response.clone().json();
              if (typeof body?.result === "string") estimate = BigInt(body.result);
            } catch {
              /* leave estimate null */
            }
            return response;
          }
        }
        return realFetch(input, init);
      };

      try {
        await client.deployContract({ code, args: deployArgs });
        throw new Error(`${name}: expected the broadcast to be blocked, but it was not`);
      } catch (error) {
        if (!/__ESTIMATE_ONLY__/.test(String(error.message))) throw error;
      } finally {
        globalThis.fetch = realFetch;
      }

      results.push({ name, bytes: code.length, estimate });
    }

    // Compare against the PER-TRANSACTION cap, which is the thing that
    // actually rejects a deploy. The block gas limit is not that number and
    // saying "fits" because a contract is under it would be a false pass --
    // exactly what happened the first time this ran, reporting "fits" for two
    // contracts the network had already refused. Only AUTOSHIELD_MAX_GAS, set
    // from a measured probe, is treated as a real ceiling here.
    const measured = gas.source === "AUTOSHIELD_MAX_GAS" ? gas.cap : null;

    console.log("\nestimate only — NOTHING was sent\n");
    for (const r of results) {
      let verdict;
      if (r.estimate === null) {
        verdict = "no estimate returned";
      } else if (measured === null) {
        verdict = "cap unknown — measure it first";
      } else if (r.estimate > measured) {
        const over = r.estimate - measured;
        const pct = Number((r.estimate * 100n) / measured) - 100;
        verdict = `DOES NOT FIT — over by ${over} (${pct}%)`;
      } else {
        verdict = "fits";
      }
      console.log(
        `  ${r.name.padEnd(22)} ${String(r.bytes).padStart(6)} bytes  ` +
          `gas ${String(r.estimate ?? "?").padStart(10)}  ${verdict}`,
      );
    }

    if (measured === null) {
      console.log(
        "\n  No per-transaction cap is known. The block gas limit " +
          `(${gas.blockGasLimit ?? "unknown"}) is NOT that cap: a network can, and\n` +
          "  Bradbury does, refuse a transaction far below it. Measure the real one:\n\n" +
          `    node scripts/probe-gas-cap.mjs --network ${options.network} [--keystore ...]\n\n` +
          "  then re-run this with AUTOSHIELD_MAX_GAS set to the measured value.",
      );
    } else {
      console.log(`\n  measured per-transaction cap   ${measured}`);
      console.log(
        "\nIf a contract does not fit, clamping the limit will not help: the gas is\n" +
          "what execution actually costs, so a lower limit fails as out-of-gas instead.",
      );
    }
    return;
  }

  // Consensus v0.6 requires a fee quote on every deploy and write. On a v0.5
  // network this is null and simply not passed.
  let fees = null;
  try {
    fees = await quoteFees(client, options.network);
    if (fees) console.log(`fees quoted   feeValue ${fees.feeValue}`);
  } catch (error) {
    throw new Error(
      `Could not quote fees on ${options.network} (${error.message}). ` +
        "Consensus v0.6 will reject a transaction without them, so nothing was sent.",
    );
  }

  const submitted = [];

  async function settle(hash, what) {
    console.log(`  submitted   ${hash}`);
    // v0.6 deprecates `status` in favour of `waitUntil`; v0.5 has no
    // `waitUntil`. Send whichever this network's SDK understands.
    const receipt = await client.waitForTransactionReceipt(
      sdkFor(options.network) === "v2"
        ? { hash, waitUntil: "finalized", interval: 5000, retries: 200 }
        : { hash, status: TransactionStatus.FINALIZED, interval: 5000, retries: 200 },
    );

    try {
      assertFinalizedAndExecuted(receipt, what);
    } catch (error) {
      // Write the whole receipt out. A failure on a remote network is only as
      // debuggable as what got printed, and a truncated line is not enough.
      const path = resolve(DEPLOYMENTS, `last-failure-${options.network}.json`);
      await mkdir(DEPLOYMENTS, { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({ what, hash, receipt }, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v, 2)}\n`,
        "utf8",
      );
      console.error("\n--- failure detail -------------------------------------");
      console.error(JSON.stringify(failureReport(receipt), null, 2));
      console.error(`--- full receipt written to ${path}`);
      throw error;
    }
    console.log(`  finalized   ${what}`);
    submitted.push({ what, hash, consensus: consensusFacts(receipt) });
    return receipt;
  }

  async function send(address, functionName, args, what) {
    // Fees are quoted per call: a write that emits a cross-contract message
    // needs an allocation covering it, and only simulating this specific call
    // reveals that.
    const callFees = (await quoteWriteFees(client, options.network, {
      address,
      functionName,
      args,
    })) ?? fees;
    const hash = await client.writeContract({
      address,
      functionName,
      args,
      value: 0n,
      ...(callFees ? { fees: callFees } : {}),
    });
    return settle(hash, what);
  }

  // ---- 5. deploy, in order, each verified before the next ---------------
  const protocolCode = protocolCodeForEstimate;
  const shieldCode = shieldCodeForEstimate;

  console.log("\ndeploying DemoLendingProtocol ...");
  const protocolReceipt = await settle(
    await client.deployContract({
      code: protocolCode,
      args: [ONE_ATTO],
      ...(fees ? { fees } : {}),
    }),
    "DemoLendingProtocol deploy",
  );
  const protocolAddress = contractAddressOf(protocolReceipt);
  console.log(`  address     ${protocolAddress}`);

  console.log("deploying AutoShield ...");
  const shieldReceipt = await settle(
    await client.deployContract({
      code: shieldCode,
      args: [addrFor(options.network, protocolAddress), addrFor(options.network, account.address)],
      ...(fees ? { fees } : {}),
    }),
    "AutoShield deploy",
  );
  const shieldAddress = contractAddressOf(shieldReceipt);
  console.log(`  address     ${shieldAddress}`);

  // ---- 6. wiring -------------------------------------------------------
  console.log("\nwiring ...");
  await send(protocolAddress, "set_initial_guard", [addrFor(options.network, shieldAddress)],
    "set_initial_guard");

  const operator = options.operator ?? account.address;
  await send(shieldAddress, "set_reporter", [addrFor(options.network, operator), true], "set_reporter");
  if (options.operator) {
    await send(shieldAddress, "set_evaluator", [addrFor(options.network, operator)], "set_evaluator");
  }

  // ---- 7. verify the wiring by reading the chain ------------------------
  console.log("\nverifying wiring by on-chain read ...");
  const status = await client.readContract({
    address: protocolAddress, functionName: "get_status", args: [],
  });
  const config = await client.readContract({
    address: shieldAddress, functionName: "get_config", args: [],
  });

  const guard = String(status.guard_address ?? "");
  if (guard.toLowerCase() !== shieldAddress.toLowerCase()) {
    throw new Error(
      `Wiring failed: protocol guard is ${guard || "(unset)"}, expected ${shieldAddress}`,
    );
  }
  if (String(config.protocol_address).toLowerCase() !== protocolAddress.toLowerCase()) {
    throw new Error(
      `Wiring failed: shield protects ${config.protocol_address}, expected ${protocolAddress}`,
    );
  }
  if (String(config.evaluator).toLowerCase() !== operator.toLowerCase()) {
    throw new Error(
      `Wiring failed: evaluator is ${config.evaluator}, expected ${operator}`,
    );
  }
  console.log(`  guard       ${guard}`);
  console.log(`  protects    ${config.protocol_address}`);
  console.log(`  evaluator   ${config.evaluator}`);
  console.log(`  mode        ${status.mode}`);

  // ---- 8. seed, then verify the seed ------------------------------------
  if (!options.noSeed) {
    console.log("\nseeding demo liquidity (deployer's own position) ...");
    let expectedDeposits = 0n;
    let expectedBorrowed = 0n;
    for (const position of SEED) {
      await send(protocolAddress, "mint_demo_balance",
        [addrFor(options.network, account.address), position.deposit * ONE_ATTO], "mint_demo_balance");
      await send(protocolAddress, "deposit", [position.deposit * ONE_ATTO], "deposit");
      expectedDeposits += position.deposit * ONE_ATTO;
      if (position.borrow > 0n) {
        await send(protocolAddress, "borrow", [position.borrow * ONE_ATTO], "borrow");
        expectedBorrowed += position.borrow * ONE_ATTO;
      }
    }

    const telemetry = await client.readContract({
      address: protocolAddress, functionName: "telemetry", args: [],
    });
    const deposits = BigInt(telemetry.total_deposits_atto);
    const borrowed = BigInt(telemetry.total_borrowed_atto);
    if (deposits !== expectedDeposits || borrowed !== expectedBorrowed) {
      throw new Error(
        `Seed verification failed: chain reports ${deposits}/${borrowed}, ` +
          `expected ${expectedDeposits}/${expectedBorrowed}`,
      );
    }
    console.log(`  deposits    ${deposits / ONE_ATTO}`);
    console.log(`  borrowed    ${borrowed / ONE_ATTO}`);
  }

  // ---- 9. deployment record, public information only --------------------
  const record = {
    network: options.network,
    chainName: chain.name,
    chainId: chain.id,
    rpc,
    explorer,
    consensusMainContract: chain.consensusMainContract?.address ?? null,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    operator,
    contracts: {
      DemoLendingProtocol: protocolAddress,
      AutoShield: shieldAddress,
    },
    transactions: submitted.map((entry) => ({
      what: entry.what,
      hash: entry.hash,
      explorer: explorer ? `${explorer.replace(/\/$/, "")}/tx/${entry.hash}` : null,
      // Kept verbatim: what the network reported about validator participation
      // on this transaction, so later claims can be checked rather than trusted.
      consensus: entry.consensus,
    })),
    frontend: {
      NEXT_PUBLIC_GENLAYER_NETWORK: options.network,
      NEXT_PUBLIC_PROTOCOL_ADDRESS: protocolAddress,
      NEXT_PUBLIC_AUTOSHIELD_ADDRESS: shieldAddress,
    },
    runnerPin: protocolPinned.pin,
    note:
      "Public information only. No private key, mnemonic or credential belongs " +
      "in this file or anywhere else in the repository.",
  };

  await mkdir(DEPLOYMENTS, { recursive: true });
  const recordPath = resolve(DEPLOYMENTS, `${options.network}.json`);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${recordPath}`);

  // ---- 10. frontend configuration --------------------------------------
  const envPath = resolve(FRONTEND, ".env.local");
  await writeFile(
    envPath,
    [
      "# Written by scripts/deploy-testnet.mjs. Gitignored, and correctly so:",
      "# it is environment-specific. Nothing secret is here -- these are public",
      "# addresses, and every NEXT_PUBLIC_* value ends up in the browser bundle.",
      "# Never add a private key or an API key to this file.",
      `NEXT_PUBLIC_GENLAYER_NETWORK=${options.network}`,
      `NEXT_PUBLIC_PROTOCOL_ADDRESS=${protocolAddress}`,
      `NEXT_PUBLIC_AUTOSHIELD_ADDRESS=${shieldAddress}`,
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`wrote ${envPath}`);

  console.log("\nDeployment complete. Every transaction above reached FINALIZED with");
  console.log("execution_result SUCCESS, and the wiring was verified by reading it back.");
  console.log("\nNext: npm run dev");
}

main().catch((error) => {
  console.error(`\ndeploy-testnet failed: ${error.message}`);
  console.error("No further transactions were sent.");
  process.exitCode = 1;
});
