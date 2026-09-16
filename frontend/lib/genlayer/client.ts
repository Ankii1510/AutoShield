/**
 * GenLayer client construction and wallet handling.
 *
 * Every GenLayerJS API used here was verified against genlayer-js@1.1.8's own
 * type declarations, not from documentation:
 *
 *   createClient({ chain, account })            -> GenLayerClient
 *   createAccount(privateKey?)                  -> local signing account
 *   client.readContract({ address, functionName, args })
 *   client.writeContract({ address, functionName, args, value })  -> tx hash
 *   client.waitForTransactionReceipt({ hash, status, interval, retries })
 *   client.getTriggeredTransactionIds({ hash })  -> async `emit` follow-ups
 *   client.connect(network?)                     -> MetaMask Snap wallet
 *   CalldataAddress (from "genlayer-js/types")   -> takes 20 RAW BYTES
 *   TransactionStatus                            -> lifecycle enum
 */

import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { CalldataAddress, TransactionStatus } from "genlayer-js/types";
import type { GenLayerChain, GenLayerClient } from "genlayer-js/types";

// The v0.5 SDK, kept alongside v2 under an npm alias.
//
// Consensus v0.6 is a protocol break, not a library bump: a v2 client cannot
// talk to a v0.5 node at all (it asks for `sim_getFeeConfig`, which does not
// exist there, and its transaction encoding is rejected). The local GenLayer
// Sim still runs v0.5 while Studio Next runs v0.6, so each network is pinned
// to the SDK that speaks its protocol.
import {
  createAccount as createAccountV1,
  createClient as createClientV1,
  generatePrivateKey as generatePrivateKeyV1,
} from "genlayer-js-v1";
import {
  localnet,
  studionet,
  testnetAsimov,
  testnetBradbury,
} from "genlayer-js-v1/chains";
import { CalldataAddress as CalldataAddressV1 } from "genlayer-js-v1/types";

export { TransactionStatus };
export type { GenLayerClient };

const DEFAULT_RPC = "http://127.0.0.1:4000/api";

/**
 * The networks this console can be pointed at, keyed by the name the GenLayer
 * CLI uses for them, so one spelling means one network everywhere.
 *
 * WHY NOT SELECT BY CHAIN ID. It is not unique. Verified against both
 * installed sources (genlayer-js@1.1.8 and genlayer CLI 0.39.2):
 *
 *   localnet          61127   http://127.0.0.1:4000/api
 *   studionet         61999   https://studio.genlayer.com/api
 *   testnet-bradbury   4221   https://rpc-bradbury.genlayer.com
 *   testnet-asimov     4221   https://rpc-asimov.genlayer.com
 *
 * Bradbury and Asimov share id 4221 and differ only in RPC endpoint and
 * consensus contract; and `scripts/glsim.sh` runs the local node on 61999 to
 * match genlayer-py, which collides with studionet. So "chain 4221" and
 * "chain 61999" each name two different networks, and picking one by id means
 * picking the wrong one half the time -- carrying the wrong consensus contract
 * address with it. The network name is the identity; the chain id is one of
 * the things verified against it.
 */
export const NETWORKS = {
  localnet: { chain: localnet as unknown as GenLayerChain, sdk: "v1" },

  /**
   * Consensus v0.6 preview, chain 61997 — the network this project must be
   * deployed on. The hackathon announcement gives the endpoint as
   * studio-next.genlayer.com; genlayer-js 2.0.0-rc.1 ships the same chain id
   * and consensus contract under studio-dev.genlayer.com, and the published
   * explorer is explorer-studio-dev. They look like one network with two
   * hostnames, but "look like" is not enough to choose one silently, so both
   * are named and the deployment says which it used.
   */
  "studio-next": {
    chain: {
      ...studioDevnet,
      name: "GenLayer Studio Next",
      rpcUrls: {
        ...studioDevnet.rpcUrls,
        default: { http: ["https://studio-next.genlayer.com/api"] },
      },
    } as unknown as GenLayerChain,
    sdk: "v2",
  },
  "studio-dev": { chain: studioDevnet as unknown as GenLayerChain, sdk: "v2" },

  studionet: { chain: studionet as unknown as GenLayerChain, sdk: "v1" },
  "testnet-bradbury": {
    chain: testnetBradbury as unknown as GenLayerChain,
    sdk: "v1",
  },
  "testnet-asimov": { chain: testnetAsimov as unknown as GenLayerChain, sdk: "v1" },
} as const;

/** Which SDK generation a network speaks: v1 = consensus v0.5, v2 = v0.6. */
export function sdkFor(name: NetworkName): "v1" | "v2" {
  return NETWORKS[name].sdk;
}

export type NetworkName = keyof typeof NETWORKS;

export function isNetworkName(value: string): value is NetworkName {
  return Object.prototype.hasOwnProperty.call(NETWORKS, value);
}

/** The configured network name, defaulting to localnet. */
export function networkName(): NetworkName {
  const configured = process.env.NEXT_PUBLIC_GENLAYER_NETWORK ?? "";
  return isNetworkName(configured) ? configured : "localnet";
}

export function resolveChain(): GenLayerChain {
  const base = NETWORKS[networkName()].chain;
  const url = rpcUrl();
  const overrideId = Number(process.env.NEXT_PUBLIC_GENLAYER_CHAIN_ID ?? "");

  return {
    ...base,
    // A chain-id override exists only for the local node, which glsim.sh runs
    // on 61999 rather than genlayer-js's 61127. It is ignored for every
    // public network, where the id is a property of the network and not
    // something a deployment gets to assert.
    id:
      networkName() === "localnet" && Number.isFinite(overrideId) && overrideId > 0
        ? overrideId
        : base.id,
    rpcUrls: { ...base.rpcUrls, default: { http: [url] } },
  } as GenLayerChain;
}

/**
 * The RPC the console will actually talk to.
 *
 * For a public network the canonical endpoint from genlayer-js wins: allowing
 * an env var to repoint a named public network at an arbitrary URL is exactly
 * the silent network switch this console must not perform.
 */
export function rpcUrl(): string {
  const name = networkName();
  if (name !== "localnet") {
    return NETWORKS[name].chain.rpcUrls.default.http[0] ?? DEFAULT_RPC;
  }
  return process.env.NEXT_PUBLIC_GENLAYER_RPC ?? DEFAULT_RPC;
}

/** The network's consensus contract, part of its identity. */
export function consensusContract(): string | null {
  const chain = NETWORKS[networkName()].chain as unknown as {
    consensusMainContract?: { address?: string };
  };
  return chain.consensusMainContract?.address ?? null;
}

/**
 * Hex address -> CalldataAddress.
 *
 * genlayer-js's CalldataAddress constructor takes a 20-byte Uint8Array and
 * throws "invalid address length" on a hex string, unlike its Python
 * counterpart. Encapsulated here so no caller has to rediscover that.
 */
export function toCalldataAddress(hex: string): CalldataAddress {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 40 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Not a 20-byte address: ${hex}`);
  }
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  // Each SDK ships its own CalldataAddress and they are not interchangeable:
  // a v1 client given a v2 instance fails with "invalid calldata input
  // '[object Object]'", which points nowhere near the real cause.
  return (
    sdkFor(networkName()) === "v2"
      ? new CalldataAddress(bytes)
      : new CalldataAddressV1(bytes)
  ) as CalldataAddress;
}

/**
 * Ask the node which chain it actually is.
 *
 * The configured chain id is an assertion, not a fact: point the console at a
 * different node and every read still "works" while describing a protocol
 * that is not the one on screen. This is the standard `eth_chainId` JSON-RPC
 * call, made directly because genlayer-js exposes no equivalent, and it is the
 * only network request this app makes outside the contract client.
 *
 * Returns null when the node cannot be reached or answers unintelligibly; the
 * caller treats that as "unknown", never as "matching".
 */
export async function reportedChainId(signal?: AbortSignal): Promise<number | null> {
  try {
    const response = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const result =
      body && typeof body === "object" ? (body as Record<string, unknown>).result : null;
    if (typeof result !== "string") return null;
    const parsed = Number.parseInt(result, 16);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ClientBundle {
  client: GenLayerClient<GenLayerChain>;
  address: string;
  chainId: number;
  /** True when signing with a browser wallet rather than an ephemeral key. */
  external: boolean;
}

/**
 * A read-only client backed by a throwaway key.
 *
 * GenLayer requires an account to sign even simulated reads, so the console
 * generates one in memory for browsing. It holds nothing, is never persisted,
 * and is replaced the moment a real wallet connects.
 */
export function createReadClient(): ClientBundle {
  const chain = resolveChain();
  const v2 = sdkFor(networkName()) === "v2";
  const account = v2
    ? createAccount(generatePrivateKey())
    : createAccountV1(generatePrivateKeyV1());
  const client = (
    v2
      ? createClient({ chain, account })
      : createClientV1({ chain: chain as never, account: account as never })
  ) as GenLayerClient<GenLayerChain>;
  return { client, address: account.address, chainId: chain.id, external: false };
}

/**
 * The key genlayer-js's own `connect()` expects, per network.
 *
 * `connect(client, network = "studionet")` takes a NETWORK KEY and ignores the
 * chain the client was built with. Its keys are its own (`studioDevnet`, not
 * `studio-next`), and both of this repository's v0.6 networks are chain 61997
 * under two hostnames, so both map to `studioDevnet`.
 */
type SnapNetwork =
  | "localnet"
  | "studionet"
  | "studioDevnet"
  | "testnetAsimov"
  | "testnetBradbury";

const SNAP_NETWORK_KEY: Record<NetworkName, SnapNetwork> = {
  localnet: "localnet",
  "studio-next": "studioDevnet",
  "studio-dev": "studioDevnet",
  studionet: "studionet",
  "testnet-bradbury": "testnetBradbury",
  "testnet-asimov": "testnetAsimov",
};

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
};

type AnnouncedProvider = {
  info?: { rdns?: string; name?: string };
  provider?: Eip1193Provider;
};

/**
 * Find MetaMask specifically, among however many wallets are installed.
 *
 * `window.ethereum` is a single slot and every injected wallet wants it. With
 * several extensions present the winner is whichever injected last, so a user
 * with MetaMask AND Phantom (or Rabby, or OKX) can easily end up with a
 * `window.ethereum` that is not MetaMask at all. GenLayer's Snap calls —
 * `wallet_getSnaps`, `wallet_requestSnaps` — exist only in MetaMask, so on any
 * other provider they reject, usually with a bare object that carries no
 * message. That is what surfaced here as a blank "Wallet connection failed"
 * next to `in-page.js` errors from an extension we never asked for.
 *
 * EIP-6963 exists for exactly this: wallets announce themselves as separate
 * providers instead of fighting over one global. We ask, wait briefly, and pick
 * the one whose rdns is MetaMask's.
 *
 * Fallbacks, in order, because 6963 support is not universal:
 *   1. the 6963 announcement whose rdns is `io.metamask`
 *   2. `window.ethereum.providers[]` — the older multi-wallet convention
 *   3. `window.ethereum` itself, but only if it claims `isMetaMask`
 *
 * If none of those find it, say so plainly rather than handing genlayer-js a
 * provider that cannot possibly work.
 */
async function metamaskProvider(): Promise<Eip1193Provider> {
  const found: AnnouncedProvider[] = [];
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<AnnouncedProvider>).detail;
    if (detail?.provider) found.push(detail);
  };

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Announcements are synchronous in practice; one tick is enough, and this
  // must not stall the click.
  await new Promise((resolve) => setTimeout(resolve, 150));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);

  const announced = found.find((entry) => entry.info?.rdns === "io.metamask");
  if (announced?.provider) return announced.provider;

  const injected = (
    globalThis as {
      ethereum?: Eip1193Provider & {
        isMetaMask?: boolean;
        providers?: (Eip1193Provider & { isMetaMask?: boolean })[];
      };
    }
  ).ethereum;

  const fromArray = injected?.providers?.find((entry) => entry.isMetaMask);
  if (fromArray) return fromArray;

  if (injected?.isMetaMask) return injected;

  if (!injected && found.length === 0) {
    throw new Error(
      "No browser wallet found. MetaMask is required for this button — " +
        "every read on this page works without one.",
    );
  }

  const names = found
    .map((entry) => entry.info?.name)
    .filter(Boolean)
    .join(", ");
  throw new Error(
    "MetaMask was not found among the installed wallets" +
      (names ? ` (${names})` : "") +
      ". GenLayer signs through a MetaMask Snap, which no other wallet " +
      "supports. Reading this console needs no wallet at all.",
  );
}

/**
 * Connect a browser wallet through GenLayerJS's MetaMask Snap integration.
 *
 * Three things here are NOT incidental, and all three were wrong before this
 * console was ever pointed at a browser wallet:
 *
 *  1. `connect()` must be given the network key. Called bare it defaults to
 *     `"studionet"` and asks MetaMask to add and switch to chain 61999 — a
 *     different network on a different consensus generation from the 61997 the
 *     rest of this page is reading.
 *  2. `connect()` ends with `client.chain = selectedNetwork`, replacing the
 *     chain this session verified against the node. For studio-next that
 *     silently swaps in the studio-dev endpoint, so ours is restored after.
 *  3. `connect()` never sets `client.account` — it only installs the Snap and
 *     sets the chain. The account has to be requested from the wallet, or
 *     every later write has nothing to sign with.
 *  4. `connect()` reads `window.ethereum`, which with several wallets installed
 *     is whichever one injected last. `metamaskProvider()` finds the real
 *     MetaMask, and it is put in that slot for the duration of the call
 *     because the SDK gives no way to pass a provider in. The previous value
 *     is restored afterwards so the rest of the page is left as it was.
 *
 * NOT VERIFIED AGAINST A REAL WALLET. This is written from the SDK's source,
 * not from a working MetaMask session; see docs/DEPLOY-CONSOLE.md step 4.
 */
export async function connectWallet(): Promise<ClientBundle> {
  const chain = resolveChain();
  const name = networkName();
  const client = (
    sdkFor(name) === "v2"
      ? createClient({ chain })
      : createClientV1({ chain: chain as never })
  ) as GenLayerClient<GenLayerChain>;

  const provider = await metamaskProvider();

  const slot = globalThis as { ethereum?: Eip1193Provider };
  const previous = slot.ethereum;
  slot.ethereum = provider;
  try {
    await client.connect(SNAP_NETWORK_KEY[name]);
  } finally {
    // Leave the page as we found it, even if connect() threw.
    if (previous === undefined) delete slot.ethereum;
    else slot.ethereum = previous;
  }

  // Undo connect()'s overwrite (point 2 above).
  (client as { chain: GenLayerChain }).chain = chain;

  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[] | undefined;
  const address = accounts?.[0] ?? null;
  if (!address) {
    throw new Error("The wallet returned no account. Unlock it and try again.");
  }
  (client as { account?: unknown }).account = address;

  return { client, address, chainId: chain.id, external: true };
}
