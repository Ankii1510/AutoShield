import { afterEach, describe, expect, it } from "vitest";

import {
  NETWORKS,
  sdkFor,
  consensusContract,
  isNetworkName,
  networkName,
  resolveChain,
  rpcUrl,
} from "@/lib/genlayer/client";

/**
 * Network identity tests.
 *
 * These exist because chain id is NOT a unique network identifier in GenLayer,
 * which is easy to assume and expensive to get wrong. Verified against the
 * installed genlayer-js@1.1.8 and genlayer CLI 0.39.2:
 *
 *   testnet-bradbury and testnet-asimov BOTH report chain 4221
 *   studionet reports 61999, which is also the id scripts/glsim.sh runs locally
 *
 * So selecting a network by id silently picks the wrong one half the time, and
 * carries the wrong consensus contract with it.
 */

const ENV = process.env;

afterEach(() => {
  delete process.env.NEXT_PUBLIC_GENLAYER_NETWORK;
  delete process.env.NEXT_PUBLIC_GENLAYER_RPC;
  delete process.env.NEXT_PUBLIC_GENLAYER_CHAIN_ID;
  process.env = { ...ENV };
});

describe("network identity", () => {
  it("confirms the chain-id collisions that motivate name-based selection", () => {
    expect(NETWORKS["testnet-bradbury"].chain.id).toBe(4221);
    expect(NETWORKS["testnet-asimov"].chain.id).toBe(4221);
    expect(NETWORKS["testnet-bradbury"].chain.id).toBe(NETWORKS["testnet-asimov"].chain.id);
    expect(NETWORKS.studionet.chain.id).toBe(61999);
    expect(NETWORKS.localnet.chain.id).toBe(61127);
  });

  it("distinguishes the two 4221 networks by endpoint and consensus contract", () => {
    const bradbury = NETWORKS["testnet-bradbury"].chain;
    const asimov = NETWORKS["testnet-asimov"].chain;
    expect(bradbury.rpcUrls.default.http[0]).not.toBe(asimov.rpcUrls.default.http[0]);
    expect(bradbury.consensusMainContract?.address).not.toBe(
      asimov.consensusMainContract?.address,
    );
  });

  it("knows Studio Next, the network the hackathon requires", () => {
    // Chain 61997, consensus v0.6. The announcement and the SDK give two
    // different hostnames for it, so both are named rather than one being
    // guessed at; they must at least agree on the chain id.
    expect(NETWORKS["studio-next"].chain.id).toBe(61997);
    expect(NETWORKS["studio-dev"].chain.id).toBe(61997);
    expect(NETWORKS["studio-next"].chain.rpcUrls.default.http[0]).toBe(
      "https://studio-next.genlayer.com/api",
    );
    expect(NETWORKS["studio-dev"].chain.rpcUrls.default.http[0]).toBe(
      "https://studio-dev.genlayer.com/api",
    );
  });

  it("pins each network to the SDK generation that speaks its protocol", () => {
    // Consensus v0.6 is a protocol break: a v2 client cannot talk to a v0.5
    // node at all. Getting this mapping wrong fails deep inside signing with
    // errors that look like our bugs rather than a version mismatch.
    expect(sdkFor("studio-next")).toBe("v2");
    expect(sdkFor("studio-dev")).toBe("v2");
    expect(sdkFor("localnet")).toBe("v1");
    expect(sdkFor("studionet")).toBe("v1");
    expect(sdkFor("testnet-bradbury")).toBe("v1");
  });

  it("rejects unknown network names instead of guessing", () => {
    expect(isNetworkName("testnet-bradbury")).toBe(true);
    expect(isNetworkName("mainnet")).toBe(false);
    expect(isNetworkName("")).toBe(false);
  });

  it("defaults to localnet when nothing is configured", () => {
    expect(networkName()).toBe("localnet");
    expect(resolveChain().id).toBe(61127);
  });

  it("falls back to localnet rather than honouring an unknown name", () => {
    process.env.NEXT_PUBLIC_GENLAYER_NETWORK = "not-a-network";
    expect(networkName()).toBe("localnet");
  });

  it("resolves a named public network to its own chain and endpoint", () => {
    process.env.NEXT_PUBLIC_GENLAYER_NETWORK = "testnet-bradbury";
    expect(resolveChain().id).toBe(4221);
    expect(rpcUrl()).toBe("https://rpc-bradbury.genlayer.com");
    expect(consensusContract()).toBe(NETWORKS["testnet-bradbury"].chain.consensusMainContract?.address);
  });

  it("refuses to let env vars repoint a public network", () => {
    process.env.NEXT_PUBLIC_GENLAYER_NETWORK = "testnet-bradbury";
    process.env.NEXT_PUBLIC_GENLAYER_RPC = "https://rpc-asimov.genlayer.com";
    process.env.NEXT_PUBLIC_GENLAYER_CHAIN_ID = "61999";

    // Both overrides are ignored: a named public network is its published
    // endpoint and its own chain id, never whatever a deployment asserts.
    expect(rpcUrl()).toBe("https://rpc-bradbury.genlayer.com");
    expect(resolveChain().id).toBe(4221);
  });

  it("still allows the local node to be repointed, which is what it is for", () => {
    process.env.NEXT_PUBLIC_GENLAYER_NETWORK = "localnet";
    process.env.NEXT_PUBLIC_GENLAYER_RPC = "http://127.0.0.1:4000/api";
    process.env.NEXT_PUBLIC_GENLAYER_CHAIN_ID = "61999";

    // glsim.sh runs the node on 61999 to match genlayer-py, not genlayer-js's
    // 61127, so the local override is a real requirement.
    expect(rpcUrl()).toBe("http://127.0.0.1:4000/api");
    expect(resolveChain().id).toBe(61999);
  });

  it("carries the named network's consensus contract, not another network's", () => {
    process.env.NEXT_PUBLIC_GENLAYER_NETWORK = "testnet-asimov";
    expect(consensusContract()).toBe(NETWORKS["testnet-asimov"].chain.consensusMainContract?.address);
    expect(consensusContract()).not.toBe(
      NETWORKS["testnet-bradbury"].chain.consensusMainContract?.address,
    );
  });
});
