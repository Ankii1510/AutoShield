/**
 * Shared GenLayer plumbing for the deployment and demo scripts.
 *
 * Both scripts need the same things and must agree on them exactly: which
 * networks exist, how an account is unlocked, and — most importantly — what
 * counts as a transaction having succeeded. Duplicating that last one would be
 * the dangerous kind of duplication, because the two copies could drift and
 * one of them would start calling a reverted transaction a success.
 *
 * Every GenLayerJS API used here was verified against genlayer-js@1.1.8's own
 * type declarations.
 */

import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createAccount as createAccountV2, createClient as createClientV2 } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import {
  CalldataAddress,
  TransactionStatus,
  transactionsStatusNumberToName,
} from "genlayer-js/types";

// The v0.5 SDK, kept deliberately alongside v2 under an npm alias.
//
// genlayer-js 2.0.0-rc.1 cannot talk to a v0.5 node at all: the local GenLayer
// Sim answers "Method not found: sim_getFeeConfig" to fee estimation and
// rejects a v2 deploy with "Invalid pointer in tuple" because the transaction
// encoding changed. Consensus v0.6 is a protocol break, not just a library
// bump. Rather than lose the fast local loop -- which is where every one of
// this project's bugs has actually been caught -- each network is pinned to
// the SDK that speaks its protocol.
import {
  createAccount as createAccountV1,
  createClient as createClientV1,
} from "genlayer-js-v1";
import * as chainsV1 from "genlayer-js-v1/chains";
import { CalldataAddress as CalldataAddressV1 } from "genlayer-js-v1/types";
import { keccak256 } from "viem";

export const ONE_ATTO = 10n ** 18n;

/**
 * Every network these scripts know, by the name the GenLayer CLI uses.
 *
 * There is no mainnet entry, and adding one is not a small change: the
 * deployment script's whole safety story is that it cannot be pointed at a
 * network where mistakes cost real money.
 *
 * Chain ids are NOT unique here — testnet-bradbury and testnet-asimov both
 * report 4221, and studionet reports 61999, which is also what
 * scripts/glsim.sh runs the local node on. That is why every lookup in this
 * codebase is by name.
 */
export const NETWORKS = {
  // Local GenLayer Sim, still running the v0.5 stack -> v1 SDK.
  localnet: { chain: chainsV1.localnet, sdk: "v1" },

  // Consensus v0.6 preview, chain 61997. The hackathon announcement gives the
  // endpoint as studio-next.genlayer.com; genlayer-js 2.0.0-rc.1 ships the
  // same chain id and consensus contract under studio-dev.genlayer.com, and
  // the published explorer is explorer-studio-dev. They appear to be one
  // network with two hostnames, but "appear to be" is not good enough to pick
  // one silently, so BOTH are named here and the caller chooses.
  "studio-next": {
    chain: {
      ...chains.studioDevnet,
      name: "GenLayer Studio Next",
      rpcUrls: {
        ...chains.studioDevnet.rpcUrls,
        default: { http: ["https://studio-next.genlayer.com/api"] },
      },
    },
    sdk: "v2",
  },
  "studio-dev": { chain: chains.studioDevnet, sdk: "v2" },

  // v0.5 networks. They still answer, and the v1 SDK is what speaks to them.
  studionet: { chain: chainsV1.studionet, sdk: "v1" },
  "testnet-bradbury": { chain: chainsV1.testnetBradbury, sdk: "v1" },
  "testnet-asimov": { chain: chainsV1.testnetAsimov, sdk: "v1" },
};

/** Which SDK generation a network speaks. */
export function sdkFor(name) {
  return NETWORKS[name]?.sdk ?? "v1";
}

/**
 * Build a client with the SDK that matches the network's protocol.
 *
 * Using the wrong one does not fail politely: a v2 client against a v0.5 node
 * produces "Invalid pointer in tuple", which reads like a bug in our code
 * rather than a protocol mismatch.
 */
export function accountFor(name, key) {
  // Both SDKs wrap viem's local account, but pairing an account from one
  // generation with a client from the other is the kind of mismatch that
  // fails deep inside signing rather than at the call site. Keep them matched.
  const create = sdkFor(name) === "v2" ? createAccountV2 : createAccountV1;
  return create(key);
}

export function clientFor(name, chain, account) {
  const create = sdkFor(name) === "v2" ? createClientV2 : createClientV1;
  return create({ chain, account });
}

/**
 * Networks that are safe to DEPLOY to. localnet has its own script.
 *
 * studio-next is first because it is the one the hackathon requires.
 */
export const DEPLOYABLE = [
  "studio-next",
  "studio-dev",
  "studionet",
  "testnet-bradbury",
  "testnet-asimov",
];

export function chainFor(name, { allow = Object.keys(NETWORKS) } = {}) {
  if (!name) {
    throw new Error(`--network is required. One of: ${allow.join(", ")}`);
  }
  if (!allow.includes(name)) {
    throw new Error(
      `Refusing to use network "${name}". Allowed here: ${allow.join(", ")}. ` +
        "There is no mainnet path in this repository.",
    );
  }
  return NETWORKS[name].chain;
}

/**
 * Resolve the RPC endpoint for a network.
 *
 * The local node is the only one whose endpoint may be overridden, because
 * glsim runs wherever it is told. A public network's endpoint comes from its
 * own definition so that no environment variable can quietly redirect a named
 * network somewhere else.
 */
export function rpcFor(name, chain) {
  if (name === "localnet") {
    return process.env.GLSIM_RPC ?? chain.rpcUrls.default.http[0];
  }
  return chain.rpcUrls.default.http[0];
}

/** The chain id to expect, allowing the documented localnet override. */
export function expectedChainId(name, chain) {
  if (name === "localnet") {
    const override = Number(process.env.GLSIM_CHAIN_ID ?? 61999);
    return Number.isFinite(override) && override > 0 ? override : chain.id;
  }
  return chain.id;
}

/**
 * Ask the node what chain it is, and refuse to continue if it disagrees.
 *
 * Called before anything is signed. A configured network is an assertion; this
 * is the only check that makes it a fact.
 */
export async function verifyNetwork(rpc, expectedId, networkName) {
  let reported;
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    reported = Number.parseInt(String(body?.result), 16);
  } catch (error) {
    throw new Error(
      `Cannot reach ${rpc} (${error.message}). Nothing was signed. ` +
        "Check network access before retrying.",
    );
  }
  if (!Number.isFinite(reported)) {
    throw new Error(`${rpc} did not return a usable chain id. Nothing was signed.`);
  }
  if (reported !== expectedId) {
    throw new Error(
      `Wrong network: ${rpc} reports chain ${reported}, but ${networkName} is ` +
        `chain ${expectedId}. Nothing was signed.`,
    );
  }
  return reported;
}

// ------------------------------------------------------------------ accounts

/**
 * Decrypt a Web3 Secret Storage (keystore v3) file.
 *
 * The GenLayer CLI stores accounts as encrypted keystores and has no raw
 * private-key export — `genlayer account export` writes another keystore — so
 * reading the keystore is the only way to reuse an account that already exists
 * in the CLI. It is also the better way round: the key stays encrypted at rest
 * and the password passes through the environment for one command.
 *
 * Standard format (scrypt or pbkdf2, AES-128-CTR, keccak256 MAC), implemented
 * with node:crypto plus viem's keccak256. Verified against a real
 * `genlayer account create` keystore: the decrypted key derives exactly the
 * address the CLI reports, and a wrong password is caught by the MAC rather
 * than yielding a silently wrong key.
 */
export function decryptKeystore(keystore, password) {
  const crypto = keystore.crypto ?? keystore.Crypto;
  if (!crypto) {
    throw new Error("That file is not a keystore: it has no crypto section.");
  }
  const { kdf, kdfparams, cipher, ciphertext, cipherparams, mac } = crypto;
  const pw = Buffer.from(password, "utf8");

  let derived;
  if (kdf === "scrypt") {
    const { n, r, p, dklen, salt } = kdfparams;
    // maxmem must exceed 128*N*r or node refuses; the CLI uses N=131072.
    derived = scryptSync(pw, Buffer.from(salt, "hex"), dklen, {
      N: n,
      r,
      p,
      maxmem: 256 * n * r,
    });
  } else if (kdf === "pbkdf2") {
    const { c, dklen, salt, prf } = kdfparams;
    if (prf && prf !== "hmac-sha256") {
      throw new Error(`Unsupported keystore prf: ${prf}`);
    }
    derived = pbkdf2Sync(pw, Buffer.from(salt, "hex"), c, dklen, "sha256");
  } else {
    throw new Error(`Unsupported keystore kdf: ${kdf}`);
  }

  const ct = Buffer.from(ciphertext, "hex");

  // MAC first: checking it before decrypting turns a wrong password into a
  // clear error instead of a plausible-looking but wrong key.
  const computed = keccak256(Buffer.concat([derived.subarray(16, 32), ct])).slice(2);
  if (computed !== String(mac).toLowerCase().replace(/^0x/, "")) {
    throw new Error("Wrong keystore password (MAC mismatch). Nothing was signed.");
  }

  if (cipher !== "aes-128-ctr") {
    throw new Error(`Unsupported keystore cipher: ${cipher}`);
  }
  const decipher = createDecipheriv(
    "aes-128-ctr",
    derived.subarray(0, 16),
    Buffer.from(cipherparams.iv, "hex"),
  );
  const key = Buffer.concat([decipher.update(ct), decipher.final()]);
  return `0x${key.toString("hex")}`;
}

/**
 * Resolve the signing key from exactly one source.
 *
 * Supplying both a raw key and a keystore is an error rather than a precedence
 * rule: quietly preferring one is how someone signs with an account they did
 * not mean to use.
 */
export async function resolvePrivateKey({ keystore, envVar = "TESTNET_PRIVATE_KEY" }) {
  const raw = process.env[envVar] ?? "";
  const hasRaw = raw !== "";
  const hasKeystore = Boolean(keystore);

  if (hasRaw && hasKeystore) {
    throw new Error(
      `Both ${envVar} and --keystore were given. Pick one, so there is no doubt ` +
        "about which account signs. Nothing was signed.",
    );
  }

  if (hasKeystore) {
    const password = process.env.KEYSTORE_PASSWORD ?? "";
    if (password === "") {
      throw new Error(
        "--keystore needs KEYSTORE_PASSWORD in the environment (the password you " +
          "set when the account was created). Nothing was signed.",
      );
    }
    let json;
    try {
      json = JSON.parse(await readFile(keystore, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read keystore ${keystore}: ${error.message}`);
    }
    return decryptKeystore(json, password);
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "No signing account. Either:\n" +
        `  - set ${envVar} to a 32-byte hex key (0x + 64 hex chars), or\n` +
        "  - pass --keystore <path> with KEYSTORE_PASSWORD set, to reuse a\n" +
        "    GenLayer CLI account (~/.genlayer/keystores/<name>.json).\n" +
        "Use a DEDICATED testnet account. Never a key that controls anything of value.",
    );
  }
  return raw;
}

// ------------------------------------------------------------------ receipts

export function leaderReceipt(receipt) {
  const leaders = receipt?.consensus_data?.leader_receipt;
  return Array.isArray(leaders) && leaders.length > 0 ? leaders[0] : null;
}

export function executionResultOf(receipt) {
  const leader = leaderReceipt(receipt);
  return leader?.execution_result ?? receipt?.txExecutionResultName ?? null;
}

export function stderrOf(receipt) {
  const leader = leaderReceipt(receipt);
  // The receipt shape differs between consensus generations: v0.5 carries the
  // message in genvm_result.stderr, v0.6's LeaderReceipt has `error` and
  // `result` and no genvm_result at all. Check every known location rather
  // than reporting an empty string, which says nothing and sends the reader
  // looking in the wrong place.
  const candidates = [
    leader?.genvm_result?.stderr,
    leader?.error,
    leader?.result,
    receipt?.error,
    receipt?.txExecutionResultName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return "";
}

/**
 * Everything about a failed transaction that is worth looking at.
 *
 * When a deploy fails on a network this machine cannot reach, the printed
 * receipt IS the debugging session. Guessing from a one-line message wastes a
 * round trip each time, so the whole thing is written to a file and the key
 * fields are summarised.
 */
export function failureReport(receipt) {
  const leader = leaderReceipt(receipt) ?? {};
  return {
    statusName: statusNameOf(receipt),
    executionResult: executionResultOf(receipt),
    txExecutionResultName: receipt?.txExecutionResultName ?? null,
    leaderKeys: Object.keys(leader),
    leaderError: leader.error ?? null,
    leaderResult:
      typeof leader.result === "string" ? leader.result.slice(0, 400) : (leader.result ?? null),
    leaderVote: leader.vote ?? null,
    leaderMode: leader.mode ?? null,
    gasUsed: leader.gas_used ?? null,
    consensus: consensusFacts(receipt),
  };
}

/**
 * Everything observable about how the network handled one transaction.
 *
 * Collected rather than summarised: the reason for going to a public testnet
 * at all is to find out what the network actually does — how many validators
 * appear, how they voted, whether the leader rotated. Summarising here would
 * throw away the evidence that makes a later claim checkable.
 */
export function consensusFacts(receipt) {
  const data = receipt?.consensus_data ?? null;
  const votes = data?.votes ?? null;
  const validators = Array.isArray(data?.validators) ? data.validators : null;
  return {
    statusName: statusNameOf(receipt),
    executionResult: executionResultOf(receipt),
    final: data?.final ?? null,
    numOfRounds: receipt?.numOfRounds ?? null,
    lastRound: receipt?.lastRound ?? null,
    voteCount: votes ? Object.keys(votes).length : null,
    votes: votes ?? null,
    validatorCount: validators ? validators.length : null,
    validatorResults: validators ? validators.map((v) => v?.execution_result ?? null) : null,
  };
}

/**
 * Assert the transaction FINALIZED *and* the contract executed successfully.
 *
 * These are two different things and conflating them is the single easiest way
 * to report a success that did not happen: on GenLayer a transaction can reach
 * ACCEPTED or FINALIZED with the contract having reverted, in which case no
 * state changed at all — and for a deploy, no contract exists.
 */
export function statusNameOf(receipt) {
  // A receipt reports its status as a name OR as a number depending on the
  // node and the call path -- glsim returns 7, which IS FINALIZED. Comparing
  // the raw value against the string enum treats a perfectly good transaction
  // as a failure, so normalise through the SDK's own mapping table.
  const name = receipt?.statusName;
  if (typeof name === "string" && name !== "") return name;
  const numeric = receipt?.status;
  if (typeof numeric === "number") {
    return transactionsStatusNumberToName[String(numeric)] ?? String(numeric);
  }
  if (typeof numeric === "string" && numeric !== "") {
    return transactionsStatusNumberToName[numeric] ?? numeric;
  }
  return null;
}

/**
 * The execution results that mean "the contract ran and returned".
 *
 * Consensus v0.6 renamed this: v0.5 reports "SUCCESS", v0.6 reports
 * "FINISHED_WITH_RETURN". Both are accepted because this repository talks to
 * both generations -- the local sim is v0.5, Studio Next is v0.6. Nothing else
 * counts: v0.6 also defines FINISHED_WITH_ERROR, TIMEOUT, NONDET_DISAGREE and
 * DETERMINISTIC_VIOLATION, and every one of those is a failure.
 *
 * NONDET_DISAGREE is worth naming out loud. It means the validators did NOT
 * agree on the non-deterministic result -- exactly the condition this project
 * has never been able to observe on a mocked local node. On Studio Next it
 * becomes visible, and it must be reported as a failed adjudication, never
 * quietly treated as a result.
 */
export const SUCCESS_RESULTS = new Set(["SUCCESS", "FINISHED_WITH_RETURN"]);

export function isSuccessResult(result) {
  return SUCCESS_RESULTS.has(String(result));
}

export function assertFinalizedAndExecuted(receipt, what) {
  const status = statusNameOf(receipt);
  const result = executionResultOf(receipt);

  if (status !== TransactionStatus.FINALIZED && status !== "FINALIZED") {
    throw new Error(`${what}: not finalized (status ${String(status)})`);
  }
  if (!isSuccessResult(result)) {
    const hint =
      String(result) === "NONDET_DISAGREE"
        ? " -- the validators did not agree on the non-deterministic result"
        : "";
    throw new Error(
      `${what}: finalized but execution failed (${String(result)})${hint}: ` +
        String(stderrOf(receipt)).slice(0, 500),
    );
  }
  return receipt;
}

export function contractAddressOf(receipt) {
  const candidates = [
    receipt?.txDataDecoded?.contractAddress,
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

// ------------------------------------------------------------------ calldata

/**
 * Hex address -> CalldataAddress.
 *
 * genlayer-js's CalldataAddress constructor takes 20 raw bytes and rejects a
 * hex string with "invalid address length", unlike its Python counterpart.
 */
function addressBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 40 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Not a 20-byte address: ${hex}`);
  }
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Hex address -> CalldataAddress, defaulting to the v2 class. */
export function addr(hex) {
  return new CalldataAddress(addressBytes(hex));
}

/**
 * Hex address -> the CalldataAddress class the network's SDK understands.
 *
 * The two SDKs each ship their own CalldataAddress, and they are not
 * interchangeable: handing a v1 client a v2 instance fails with
 * "invalid calldata input '[object Object]'", which says nothing about the
 * real cause. Addresses have to be matched to the client just like accounts.
 */
export function addrFor(name, hex) {
  const bytes = addressBytes(hex);
  return sdkFor(name) === "v2"
    ? new CalldataAddress(bytes)
    : new CalldataAddressV1(bytes);
}

export { TransactionStatus };

// ---------------------------------------------------------------------- gas

/**
 * Clamp the gas limit genlayer-js asks for to what the network will accept.
 *
 * WHY THIS IS NEEDED. `deployContract` routes through an internal
 * `_sendTransaction` that takes `estimateTransactionGas`'s answer VERBATIM.
 * There is no cap and no `gas` option on the public API. Our contracts are
 * large (about 50 KB and 34 KB of source, all of which travels as calldata),
 * and Testnet Bradbury rejects the resulting estimate outright with
 * `-32602 ... gas limit too high`, before executing anything.
 *
 * WHY IT INTERCEPTS fetch. The obvious fix — replacing
 * `client.estimateTransactionGas` — does nothing: genlayer-js builds its
 * contract actions over an INTERNAL client object captured before the one
 * `createClient` returns, so the internal call never sees the replacement.
 * (Verified by patching it and watching a deploy ignore the patch entirely.)
 * Its transport issues plain `fetch` POSTs to the RPC URL, so that is the one
 * place every path genuinely passes through.
 *
 * The interception is deliberately narrow: only POSTs to this exact RPC URL,
 * only the `eth_estimateGas` method, and only ever LOWERING the number. It
 * cannot make a transaction spend more, and if the clamped limit is too small
 * the transaction fails as out-of-gas and is reported as a failure — never as
 * a success. `restore()` puts the original fetch back.
 */
export async function clampGasToBlockLimit(rpc, { headroom = 0.9 } = {}) {
  // An explicit override, for a network whose real per-transaction ceiling is
  // lower than its block gas limit. A decimal number of gas units.
  const override = process.env.AUTOSHIELD_MAX_GAS ?? "";
  let overrideCap = null;
  if (override !== "") {
    try {
      overrideCap = BigInt(override);
      if (overrideCap <= 0n) throw new Error("must be positive");
    } catch {
      throw new Error(
        `AUTOSHIELD_MAX_GAS must be a positive whole number, got: ${override}`,
      );
    }
  }

  let blockGasLimit = null;
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      }),
    });
    const body = await response.json();
    const raw = body?.result?.gasLimit;
    if (typeof raw === "string") blockGasLimit = BigInt(raw);
  } catch {
    blockGasLimit = null;
  }

  if (blockGasLimit === null && overrideCap === null) {
    return { blockGasLimit: null, cap: null, restore: () => {} };
  }

  const cap =
    overrideCap ?? (blockGasLimit * BigInt(Math.round(headroom * 100))) / 100n;

  const originalFetch = globalThis.fetch;
  let clamped = 0;
  let reported = 0;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    if (url !== rpc || !init?.body) {
      return originalFetch(input, init);
    }

    let payload;
    try {
      payload = JSON.parse(init.body);
    } catch {
      return originalFetch(input, init);
    }
    if (payload?.method !== "eth_estimateGas") {
      return originalFetch(input, init);
    }

    const response = await originalFetch(input, init);
    let body;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    if (typeof body?.result !== "string") return response;

    const estimated = BigInt(body.result);
    if (estimated <= cap) {
      // Report the first estimate and nothing after: one line is the useful
      // diagnostic, a line per transaction is noise.
      if (reported === 0) {
        reported += 1;
        console.log(`  gas         estimate ${estimated}, cap ${cap} — within cap`);
      }
      return response;
    }

    clamped += 1;
    console.log(`  gas         estimate ${estimated}, cap ${cap} — CLAMPED`);
    return new Response(
      JSON.stringify({ ...body, result: `0x${cap.toString(16)}` }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  return {
    blockGasLimit,
    cap,
    source: overrideCap ? "AUTOSHIELD_MAX_GAS" : "block limit",
    get clampedCount() {
      return clamped;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

// ---------------------------------------------------------------------- fees

/**
 * Quote the fees a v0.6 transaction must carry.
 *
 * Consensus v0.6 requires every deploy and write to submit a fee distribution;
 * a transaction without one is not merely cheaper, it is invalid. The SDK
 * quotes it from the network's own current prices, which is the only correct
 * source -- fee arithmetic done by hand goes stale the moment the network
 * reprices.
 *
 * Returns null on a v0.5 network, where the parameter does not exist and
 * passing one would be meaningless.
 */
/**
 * Quote fees for ONE specific write, including any internal messages it sends.
 *
 * A single blanket quote is not enough on v0.6. `execute_response` emits a
 * cross-contract message to the protected protocol, and the network rejects
 * the transaction with `fee no_matching_allocation # internal` unless the fee
 * distribution carries an allocation covering that message. The SDK derives
 * the allocations by simulating the call, which is the only way to get them
 * right -- they depend on what the contract actually does.
 *
 * Returns null on a v0.5 network, where fees do not exist.
 */
export async function quoteWriteFees(client, network, { address, functionName, args }) {
  if (sdkFor(network) !== "v2") return null;
  try {
    const estimate = await client.estimateTransactionFeesForWrite({
      address,
      functionName,
      args,
    });
    return {
      distribution: estimate.distribution,
      messageAllocations: estimate.messageAllocations,
      feeValue: estimate.feeValue,
    };
  } catch {
    // The estimator works by simulating the call, so it fails whenever the
    // call itself would revert -- a reporter still inside its cooldown, for
    // instance. That is not a reason to refuse to send: the transaction
    // should be submitted and allowed to fail on chain with its real error,
    // rather than being blocked here by a fee quote. Fall back to the blanket
    // quote and let the network speak.
    return null;
  }
}

export async function quoteFees(client, network) {
  if (sdkFor(network) !== "v2") return null;
  const estimate = await client.estimateTransactionFees();
  return {
    distribution: estimate.distribution,
    messageAllocations: estimate.messageAllocations,
    feeValue: estimate.feeValue,
  };
}

// -------------------------------------------------------------- runner pins

/**
 * The GenVM runner each consensus generation accepts.
 *
 * Both contracts pin a runner in their first line, and the pin is not
 * portable: deploying the v0.5-pinned source to Studio Next failed with
 * `contract_error: invalid_contract runner malformed` -- the validators all
 * agreed the contract was malformed, which is consensus working exactly as it
 * should.
 *
 * Since the v0.6 migration this repository targets ONE generation. Both
 * contracts are committed with the v0.6 pin and use v0.6-only SDK spellings
 * (`gl.contract.get_at`, `gl.message.raw`, `genlayer.storage.allow`,
 * `on="decided"`), so the v0.5 hash is kept here only to be recognised and
 * refused, never to be substituted in.
 */
export const RUNNER_PINS = {
  // Retired. Named so a stale checkout is diagnosed rather than deployed.
  v1: "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6",
  // Found by inspecting the GenVM v0.6.0-rc3 runner index: four py-genlayer
  // runners sit under `executor/*/legacy-runners/` (the v0.5 hash among them)
  // and exactly one under the modern `runners/` path. Confirmed against Studio
  // Next by deploying with each: the legacy hashes are rejected before the
  // contract runs ("invalid_contract runner malformed"), this one is accepted
  // and the contract executes.
  v2: "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng",
};

/**
 * Verify the contract's committed runner pin suits the target network.
 *
 * This REPLACED a function that rewrote the pin at deploy time. Rewriting was
 * right while one audited source had to run on both consensus generations; it
 * is wrong now, because the source itself is v0.6-only. Swapping in the v0.5
 * pin today would produce a contract that the node accepts and that then dies
 * at import, on-chain, for reasons the pin comment would actively hide.
 *
 * So this reads the pin and refuses anything it does not expect -- an
 * unpinned first line, a stale v0.5 pin, or a v0.5-generation target network.
 * Returning the source unchanged is the only success case.
 */
export function verifyRunnerPin(network, source) {
  const [first] = source.split("\n");
  const match = /^#\s*\{\s*"Depends":\s*"([^"]+)"\s*\}\s*$/.exec(first ?? "");
  if (!match) {
    throw new Error(
      "Contract source does not start with a runner pin comment, so the runner " +
        `cannot be verified. First line was: ${String(first).slice(0, 80)}`,
    );
  }
  const pin = match[1];
  if (sdkFor(network) !== "v2") {
    throw new Error(
      `${network} runs consensus v0.5, and these contracts are v0.6-only ` +
        "source. Deploying them there would produce a contract that fails at " +
        "import on-chain. Deploy to studio-next (or another v0.6 network) " +
        "instead.",
    );
  }
  if (pin === RUNNER_PINS.v1) {
    throw new Error(
      "Contract is still pinned to the retired v0.5 runner " +
        `(${RUNNER_PINS.v1}). Studio Next rejects it as "invalid_contract ` +
        'runner malformed". Expected the v0.6 pin: ' +
        RUNNER_PINS.v2,
    );
  }
  if (pin !== RUNNER_PINS.v2) {
    throw new Error(
      `Contract is pinned to an unrecognised runner (${pin}). Refusing to ` +
        "deploy rather than guess. Expected: " + RUNNER_PINS.v2,
    );
  }
  return { source, pin };
}
