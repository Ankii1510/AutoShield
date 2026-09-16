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
 * Connect a browser wallet through GenLayerJS's MetaMask Snap integration.
 *
 * `client.connect()` is the supported entry point in genlayer-js@1.1.8. No
 * extra permissions are requested and no key material is ever read.
 */
export async function connectWallet(): Promise<ClientBundle> {
  const chain = resolveChain();
  const client = (
    sdkFor(networkName()) === "v2"
      ? createClient({ chain })
      : createClientV1({ chain: chain as never })
  ) as GenLayerClient<GenLayerChain>;
  await client.connect();

  const account = client.account;
  const address =
    typeof account === "string" ? account : (account?.address ?? null);
  if (!address) {
    throw new Error("Wallet connected but returned no address");
  }

  return { client, address, chainId: chain.id, external: true };
}
