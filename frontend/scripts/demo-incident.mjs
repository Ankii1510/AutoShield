#!/usr/bin/env node
/**
 * Run one controlled AutoShield incident end to end, against a deployed
 * instance, from the command line.
 *
 * WHY THIS EXISTS. AutoShield is an autonomous emergency response system. In
 * production the thing that files an incident is a monitoring service, not a
 * person clicking a button — so the reporter and evaluator are ordinary
 * backend accounts, and nothing in the flow needs a browser wallet. This
 * script is that operator: it drives the full lifecycle with a CLI account,
 * while the web console watches the same chain state and updates on its own.
 *
 * It is also how the flow gets exercised on a public testnet without anyone
 * having to connect MetaMask.
 *
 *     node scripts/demo-incident.mjs --network localnet --scenario critical
 *     node scripts/demo-incident.mjs --network testnet-bradbury \
 *       --keystore ~/.genlayer/keystores/ops.json --scenario oracle --repeat 3
 *
 * WHAT IS REAL HERE. Everything except the observation:
 *
 *     SIMULATED OBSERVATION  -> the demo protocol's own owner-only simulate_*
 *                               methods move its reported telemetry. No
 *                               exploit code, no real protocol, no funds.
 *     REAL INCIDENT TX       -> a real write to AutoShield
 *     REAL ADJUDICATION      -> gl.vm.run_nondet under validator consensus
 *     REAL ON-CHAIN RESULT   -> severity + six flags stored; derive_level()
 *                               decides; the protocol mode really changes
 *
 * Every transaction must reach FINALIZED *and* report execution SUCCESS.
 * Every outcome is read back from the chain rather than assumed, and the level
 * is never computed here — it is read, and cross-checked against the
 * contract's own preview_level view.
 *
 * `--repeat N` runs the same scenario N times and reports the spread of
 * severities and signal flags. That measurement is the only honest basis for
 * ever revisiting SEVERITY_TOLERANCE, which this script never changes.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TransactionStatus,
  accountFor,
  clientFor,
  quoteFees,
  quoteWriteFees,
  addrFor,
  assertFinalizedAndExecuted,
  failureReport,
  chainFor,
  clampGasToBlockLimit,
  consensusFacts,
  expectedChainId,
  resolvePrivateKey,
  rpcFor,
  verifyNetwork,
} from "./lib/genlayer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "..");
const ROOT = resolve(FRONTEND, "..");
const DEPLOYMENTS = resolve(ROOT, "deployments");

/**
 * Safe scenarios. Each one only moves the demo protocol's own reported
 * telemetry through its owner-only simulate_* methods; none of them touches
 * accounting, and none of them is an exploit.
 *
 * `claimed` is reporter-supplied metadata — an assertion about what was seen,
 * not a finding. The evaluator weighs it against the protocol's real telemetry.
 */
const SCENARIOS = {
  normal: {
    label: "Normal operation",
    // The contract accepts exactly four categories: ORACLE_DEVIATION,
    // BORROW_ANOMALY, LIQUIDITY_DRAIN, TX_PATTERN. A benign report still has
    // to name one of them -- the category says what was looked at, not what
    // was concluded.
    category: "TX_PATTERN",
    setup: [],
    claimed: { note: "routine activity, no anomaly observed" },
    expect: "SAFE — nothing corroborates a threat",
  },
  oracle: {
    label: "Oracle price anomaly",
    category: "ORACLE_DEVIATION",
    setup: [["simulate_oracle_move", [4100, "DOWN"]]],
    claimed: { deviation_bps: 4100, direction: "DOWN", window_seconds: 120 },
    expect: "PROTECT or HALT depending on corroboration",
  },
  liquidity: {
    label: "Liquidity drain",
    category: "LIQUIDITY_DRAIN",
    setup: [["simulate_liquidity_drain", [3500]]],
    claimed: { drained_bps: 3500, window_seconds: 300 },
    expect: "PROTECT or HALT",
  },
  borrow: {
    label: "Borrowing anomaly",
    category: "BORROW_ANOMALY",
    setup: [["simulate_borrow_spike", [2800]]],
    claimed: { window_volume_bps: 2800 },
    expect: "PROTECT or HALT",
  },
  coordinated: {
    label: "Coordinated suspicious activity",
    category: "TX_PATTERN",
    setup: [["simulate_tx_burst", [420, 6, 7200]]],
    claimed: {
      tx_count: 420,
      unique_senders: 6,
      top_sender_share_bps: 7200,
      note: "burst concentrated in very few senders",
    },
    expect: "PROTECT or HALT depending on corroboration",
  },
  critical: {
    label: "Critical exploit pattern",
    category: "ORACLE_DEVIATION",
    setup: [
      ["simulate_oracle_move", [5200, "DOWN"]],
      ["simulate_liquidity_drain", [4400]],
      ["simulate_borrow_spike", [3900]],
    ],
    claimed: {
      deviation_bps: 5200,
      drained_bps: 4400,
      window_volume_bps: 3900,
      note: "multiple independent indicators within one short window",
    },
    expect: "HALT — high severity with corroborating signals",
  },
};

const SIGNAL_NAMES = [
  "price_manipulation",
  "liquidity_drain",
  "borrow_anomaly",
  "coordinated_activity",
  "evidence_inconsistent",
  "condition_resolved",
];

const USAGE = [
  "Usage: node scripts/demo-incident.mjs --network <name> [options]",
  "",
  `  --network <name>    required: localnet | studionet | testnet-bradbury | testnet-asimov`,
  `  --scenario <name>   ${Object.keys(SCENARIOS).join(" | ")}   (default: critical)`,
  "  --keystore <path>   GenLayer CLI account, with KEYSTORE_PASSWORD set",
  "  --repeat <n>        run the scenario n times and report the spread (default 1)",
  "  --no-execute        adjudicate only; do not apply the protective response",
  "",
  "  Addresses come from deployments/<network>.json, or from frontend/.env.local.",
  "",
  "  Signing account: TESTNET_PRIVATE_KEY, or --keystore + KEYSTORE_PASSWORD.",
  "  The account must be BOTH an authorised reporter and the evaluator.",
].join("\n");

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
      "  node scripts/demo-incident.mjs --network <name> [other options]\n",
  );
}

function parseArgs(argv) {
  const out = {
    network: null,
    scenario: "critical",
    keystore: null,
    repeat: 1,
    noExecute: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--network") { out.network = argv[++i] ?? null; }
    else if (arg === "--scenario") { out.scenario = argv[++i] ?? null; }
    else if (arg === "--keystore") { out.keystore = argv[++i] ?? null; }
    else if (arg === "--repeat") { out.repeat = Number(argv[++i]); }
    else if (arg === "--no-execute") { out.noExecute = true; }
    else if (arg === "--help" || arg === "-h") { out.help = true; }
    else throw npmStrippedArgs(arg);
  }
  if (!out.help) {
    if (!SCENARIOS[out.scenario]) {
      throw new Error(
        `Unknown scenario "${out.scenario}". One of: ${Object.keys(SCENARIOS).join(", ")}`,
      );
    }
    if (!Number.isInteger(out.repeat) || out.repeat < 1 || out.repeat > 20) {
      throw new Error("--repeat must be a whole number between 1 and 20");
    }
  }
  return out;
}

/**
 * Where the contracts are.
 *
 * The deployment record is preferred because it is the durable, committed
 * statement of what was deployed; .env.local is the local fallback that the
 * deploy scripts also write.
 */
async function loadAddresses(network) {
  try {
    const record = JSON.parse(
      await readFile(resolve(DEPLOYMENTS, `${network}.json`), "utf8"),
    );
    if (record.contracts?.AutoShield && record.contracts?.DemoLendingProtocol) {
      return {
        protocol: record.contracts.DemoLendingProtocol,
        shield: record.contracts.AutoShield,
        source: `deployments/${network}.json`,
      };
    }
  } catch {
    // Fall through to .env.local.
  }

  try {
    const env = await readFile(resolve(FRONTEND, ".env.local"), "utf8");
    const pick = (key) =>
      env.split("\n").find((line) => line.startsWith(`${key}=`))?.split("=")[1]?.trim();
    const protocol = pick("NEXT_PUBLIC_PROTOCOL_ADDRESS");
    const shield = pick("NEXT_PUBLIC_AUTOSHIELD_ADDRESS");

    // .env.local holds ONE deployment, and it names which network it is for.
    // Without this check a testnet run would happily pick up localnet
    // addresses left behind by `deploy-local.mjs` and report on contracts that
    // do not exist on the network being asked about -- or, worse, on a
    // different network's contracts that happen to exist at those addresses.
    const envNetwork = pick("NEXT_PUBLIC_GENLAYER_NETWORK") ?? "localnet";
    if (protocol && shield && envNetwork === network) {
      return { protocol, shield, source: "frontend/.env.local" };
    }
    if (protocol && shield && envNetwork !== network) {
      throw new Error(
        `frontend/.env.local holds a ${envNetwork} deployment, but --network says ` +
          `${network}. Refusing to use one network's addresses against another. ` +
          `Deploy to ${network} first, or run with --network ${envNetwork}.`,
      );
    }
  } catch (error) {
    // A genuine mismatch must surface; a missing or unreadable file falls
    // through to the deploy instructions below.
    if (/Refusing to use one network/.test(error.message)) throw error;
  }

  // Call node directly in this hint, not `npm run`: on Windows npm swallows
  // the flag names (see npmStrippedArgs), so suggesting the npm form here
  // would hand the user a command that fails.
  throw new Error(
    `No deployment found for ${network}. Deploy first:\n\n` +
      "  localnet:\n" +
      "    node scripts/deploy-local.mjs\n\n" +
      `  ${network}:\n` +
      `    node scripts/deploy-testnet.mjs --network ${network} \\\n` +
      "      --keystore <path to keystore> --operator 0xYourAddress\n\n" +
      "The deployment writes deployments/<network>.json, which is what this\n" +
      "script reads. Nothing was signed.",
  );
}

/**
 * Let the reporter cooldown elapse.
 *
 * On a real network this means waiting, because chain time is wall time and
 * the cooldown is a real anti-spam control that applies to this operator like
 * anyone else. Weakening or skipping it would mean demonstrating a system that
 * does not exist.
 *
 * The local GenLayer Sim node is different in a way that matters: its contract
 * clock does not advance with wall time at all (a documented glsim quirk — see
 * docs/ARCHITECTURE.md), so sleeping there waits forever for a clock that
 * never moves. localnet exposes `sim_increaseTime` for exactly this, and it is
 * what the integration suite already uses. It is used ONLY for localnet, and
 * never reachable on a public network.
 */
async function waitOutCooldown(network, rpc, seconds) {
  if (network === "localnet") {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sim_increaseTime",
        params: [seconds],
      }),
    });
    const body = await response.json();
    if (body.error) {
      throw new Error(`sim_increaseTime failed: ${JSON.stringify(body.error)}`);
    }
    console.log(
      `   advanced the LOCAL simulated clock by ${seconds}s ` +
        "(localnet only — its chain clock does not follow wall time)",
    );
    return;
  }
  console.log(`   waiting ${seconds}s for the reporter cooldown (not skipped)`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
}

function describeSignals(bits) {
  const set = SIGNAL_NAMES.filter((_, index) => (Number(bits) >> index) & 1);
  return set.length > 0 ? set.join(", ") : "none";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const scenario = SCENARIOS[options.scenario];
  const chain = chainFor(options.network);
  const rpc = rpcFor(options.network, chain);
  const chainId = expectedChainId(options.network, chain);
  const addresses = await loadAddresses(options.network);

  const key = await resolvePrivateKey({ keystore: options.keystore });
  const account = accountFor(options.network, key);
  const client = clientFor(options.network, { ...chain, id: chainId }, account);

  console.log(`network     ${options.network} (chain ${chainId})`);
  console.log(`rpc         ${rpc}`);
  console.log(`operator    ${account.address}`);
  console.log(`addresses   ${addresses.source}`);
  console.log(`  protocol  ${addresses.protocol}`);
  console.log(`  shield    ${addresses.shield}`);
  console.log(`scenario    ${options.scenario} — ${scenario.label}`);
  console.log(`expecting   ${scenario.expect}`);

  await verifyNetwork(rpc, chainId, options.network);
  console.log(`verified    node reports chain ${chainId}`);
  await clampGasToBlockLimit(rpc);
  console.log("");

  const read = (address, functionName, args = []) =>
    client.readContract({ address, functionName, args });

  // Refuse early and clearly rather than failing mid-flow on a permission the
  // operator was always going to need.
  const config = await read(addresses.shield, "get_config");
  const isReporter = await read(addresses.shield, "is_reporter", [
    addrFor(options.network, account.address),
  ]);
  if (isReporter !== true) {
    throw new Error(
      `${account.address} is not an authorised reporter on this deployment. ` +
        "The owner must call set_reporter(address, true). Nothing was signed.",
    );
  }
  if (String(config.evaluator).toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `${account.address} is not the evaluator (that is ${config.evaluator}), so ` +
        "adjudication would be rejected. Nothing was signed.",
    );
  }

  const runs = [];

  // Consensus v0.6 requires a fee quote on every write; null on v0.5.
  const fees = await quoteFees(client, options.network);
  if (fees) console.log(`fees        quoted, feeValue ${fees.feeValue}`);

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
    const receipt = await client.waitForTransactionReceipt({
      hash,
      status: TransactionStatus.FINALIZED,
      interval: options.network === "localnet" ? 1000 : 5000,
      retries: 200,
    });
    try {
      assertFinalizedAndExecuted(receipt, what);
    } catch (error) {
      // A failure on a remote network is only as debuggable as what got
      // printed, so keep the whole receipt rather than a truncated line.
      await mkdir(DEPLOYMENTS, { recursive: true });
      const path = resolve(DEPLOYMENTS, `last-failure-${options.network}.json`);
      await writeFile(
        path,
        `${JSON.stringify({ what, hash, receipt }, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v, 2)}\n`,
        "utf8",
      );
      console.error("\n--- failure detail ---");
      console.error(JSON.stringify(failureReport(receipt), null, 2).slice(0, 1200));
      console.error(`--- full receipt: ${path}`);
      throw error;
    }
    return { hash, receipt };
  }

  for (let run = 1; run <= options.repeat; run += 1) {
    console.log(`──── run ${run} of ${options.repeat} ────────────────────────────`);

    // 1. baseline
    let status = await read(addresses.protocol, "get_status");
    console.log(`1. protocol mode           ${status.mode}`);

    // 2. simulated observation (the ONLY simulated part)
    if (scenario.setup.length === 0) {
      console.log("2. observation             none — baseline scenario");
    } else {
      for (const [method, args] of scenario.setup) {
        await send(addresses.protocol, method, args, method);
        console.log(`2. observation             ${method}(${args.join(", ")}) [SIMULATED]`);
      }
    }
    const telemetry = await read(addresses.protocol, "telemetry");
    console.log(
      `   telemetry now          deviation ${telemetry.deviation_bps} bps, ` +
        `liquidity delta ${telemetry.liquidity_delta_bps} bps, ` +
        `borrow window ${telemetry.window_volume_bps} bps`,
    );

    // 3 + 4. incident with evidence — a real transaction
    const nowTs = Number(status.now_ts);
    const evidenceHash = `0x${run.toString(16).padStart(8, "0")}${Date.now().toString(16).padStart(56, "0")}`.slice(0, 66);
    // The reporter cooldown applies to this operator like anyone else, and a
    // previous run (even from an earlier invocation) may still be inside it.
    // Waiting it out is the only correct response -- the alternative would be
    // to weaken an anti-spam control to make a demo convenient.
    const reportArgs = [
      scenario.category,
      nowTs,
      evidenceHash,
      `ipfs://autoshield/demo/${options.scenario}`,
      JSON.stringify(scenario.claimed),
    ];
    let report;
    try {
      report = await send(addresses.shield, "report_incident", reportArgs, "report_incident");
    } catch (error) {
      if (!/cooldown/i.test(error.message)) throw error;
      const cooldown = Number(config.report_cooldown_seconds ?? 60) + 3;
      console.log("   reporter cooldown active — letting it elapse, then retrying once");
      await waitOutCooldown(options.network, rpc, cooldown);
      const fresh = await read(addresses.protocol, "get_status");
      reportArgs[1] = Number(fresh.now_ts);
      report = await send(addresses.shield, "report_incident", reportArgs, "report_incident");
    }
    const ids = await read(addresses.shield, "list_incidents");
    const incidentId = ids[ids.length - 1];
    console.log(`3. incident created        ${incidentId}  [REAL tx ${report.hash.slice(0, 14)}…]`);
    console.log(`4. evidence submitted      ${scenario.category}, hash ${evidenceHash.slice(0, 14)}…`);

    // 5 + 6. adjudication under consensus
    console.log("5. adjudicating            (GenLayer validators running)…");
    const adjudication = await send(
      addresses.shield,
      "adjudicate",
      [incidentId],
      "adjudicate",
    );
    const facts = consensusFacts(adjudication.receipt);
    console.log(`6. finalized               ${facts.statusName} / ${facts.executionResult}`);
    console.log(
      `   validators reported    ${facts.validatorCount ?? "not exposed"}` +
        (facts.voteCount !== null ? `, votes ${facts.voteCount}` : "") +
        (facts.numOfRounds !== null ? `, rounds ${facts.numOfRounds}` : ""),
    );
    if (facts.votes) {
      const tally = {};
      for (const vote of Object.values(facts.votes)) {
        tally[vote] = (tally[vote] ?? 0) + 1;
      }
      console.log(`   vote tally             ${JSON.stringify(tally)}`);
    }

    // 7 + 8. the authoritative result, read back from the chain
    const incident = await read(addresses.shield, "get_incident", [incidentId]);
    const severity = Number(incident.severity);
    const bits = Number(incident.signals_bits);
    const level = String(incident.level);
    console.log(`7. severity                ${severity} / 100`);
    console.log(`   signals                ${describeSignals(bits)}`);
    console.log(`8. response level          ${level}   [read from chain, not derived here]`);

    // Cross-check against the contract's own policy view. A mismatch would
    // mean the stored level did not come from derive_level(), which is the
    // one thing this whole design rests on.
    const preview = await read(addresses.shield, "preview_level", [severity, bits]);
    if (String(preview) !== level) {
      throw new Error(
        `POLICY MISMATCH: stored level ${level} but preview_level(${severity}, ${bits}) ` +
          `says ${preview}. Stopping — this must be investigated, not worked around.`,
      );
    }
    console.log(`   policy cross-check     preview_level agrees: ${preview}`);

    // 9 + 10. protective response, and the protocol's real state
    if (!options.noExecute && (level === "PROTECT" || level === "HALT")) {
      await send(addresses.shield, "execute_response", [incidentId], "execute_response");
      console.log("9. response executed       [REAL tx]");
    } else {
      console.log(`9. response                none applied (${level})`);
    }

    status = await read(addresses.protocol, "get_status");
    console.log(`10. protocol mode now      ${status.mode}`);
    console.log(`    repay still enabled    ${status.repay_enabled}`);
    if (status.repay_enabled !== true) {
      throw new Error(
        "ANTI-BRICK VIOLATION: repayment is disabled. This must never happen in any " +
          "mode. Stopping.",
      );
    }
    console.log(`    expires at             ${status.mode_deadline_ts ?? "n/a"}\n`);

    runs.push({
      run,
      incidentId,
      severity,
      signalsBits: bits,
      signals: describeSignals(bits),
      level,
      protocolMode: status.mode,
      reportTx: report.hash,
      adjudicationTx: adjudication.hash,
      consensus: facts,
    });

    // Return the protocol to NORMAL between runs so each run starts clean,
    // then wait out the reporter cooldown.
    //
    // The cooldown is one of the contract's anti-spam controls, and it applies
    // to this operator exactly as it would to anyone else. Waiting is the
    // correct behaviour: a repeat run that skipped it would be measuring a
    // system that does not exist. There is a sim-only RPC that could fast
    // forward the local clock, and it is deliberately not used here -- a
    // production script must not carry a test-only bypass.
    if (run < options.repeat) {
      await send(addresses.protocol, "clear_response", [], "clear_response");
      await send(addresses.protocol, "reset_simulation", [], "reset_simulation");

      const cooldown = Number(config.report_cooldown_seconds ?? 60) + 3;
      await waitOutCooldown(options.network, rpc, cooldown);
      console.log("");
    } else {
      console.log("");
    }
  }

  // ---- variance, if more than one run ------------------------------------
  if (runs.length > 1) {
    const severities = runs.map((r) => r.severity);
    const levels = [...new Set(runs.map((r) => r.level))];
    const signalSets = [...new Set(runs.map((r) => r.signals))];
    const spread = Math.max(...severities) - Math.min(...severities);

    console.log("──── variance across runs ──────────────────────────");
    console.log(`severities          ${severities.join(", ")}`);
    console.log(`spread              ${spread}  (SEVERITY_TOLERANCE is 15, unchanged)`);
    console.log(`levels              ${levels.join(", ")}`);
    console.log(`signal sets         ${signalSets.length} distinct`);
    for (const set of signalSets) console.log(`  - ${set}`);
    if (spread === 0) {
      console.log(
        "\nA spread of 0 proves nothing on its own. If the evaluator is mocked —\n" +
          "which is the default on localnet, and what the integration suite installs —\n" +
          "every validator sees the same canned answer and agreement is guaranteed by\n" +
          "construction. Real variance can only be measured where a real model runs.",
      );
    }
    if (levels.length > 1) {
      console.log(
        "\nNOTE: the same scenario produced DIFFERENT response levels across runs.\n" +
          "That is a real stability finding. Record it, diagnose the cause, and do\n" +
          "NOT widen the tolerance to make it go away.",
      );
    }
  }

  // ---- record -------------------------------------------------------------
  await mkdir(DEPLOYMENTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(DEPLOYMENTS, `${options.network}-demo-${stamp}.json`);
  await writeFile(
    path,
    `${JSON.stringify(
      {
        network: options.network,
        chainId,
        rpc,
        ranAt: new Date().toISOString(),
        operator: account.address,
        scenario: options.scenario,
        scenarioLabel: scenario.label,
        contracts: addresses,
        runs,
        note:
          "Public information only. The observation step is simulated (the demo " +
          "protocol's own telemetry); the incident, adjudication and response are " +
          "real on-chain transactions.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\nwrote ${path}`);
}

main().catch((error) => {
  console.error(`\ndemo-incident failed: ${error.message}`);
  process.exitCode = 1;
});
