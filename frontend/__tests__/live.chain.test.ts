import { beforeAll, describe, expect, it } from "vitest";

import { AutoShieldService, addressesFromEnv } from "@/lib/contracts/service";
import { createReadClient, networkName, rpcUrl } from "@/lib/genlayer/client";

/**
 * Live chain test: the console's own service layer against a real node.
 *
 * The other frontend tests are pure. This one exercises the code path a real
 * deployment uses -- client construction, calldata encoding, contract reads,
 * decoding -- against an actual GenLayer node, because that is the only way to
 * find out whether the decoders match what a node really returns.
 *
 * It SKIPS, visibly, when no node or no deployment is configured, and it never
 * passes vacuously: reachability is resolved before the suite is defined, so a
 * skipped run reports as skipped rather than as a green assertion that never
 * executed. To run it:
 *
 *     ../scripts/glsim.sh restart 5
 *     npm run deploy:local
 *     npm test
 *
 * The deploy scripts write .env.local, which vitest.config.ts loads. The same
 * test is valid against a public testnet once .env.local points there.
 */

const addresses = addressesFromEnv();

/** Resolved at module load, so `describe.skipIf` can use it. */
const reachable = addresses !== null && (await nodeReachable());

async function nodeReachable(): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

if (!addresses) {
  console.warn(
    "live chain tests SKIPPED: no NEXT_PUBLIC_PROTOCOL_ADDRESS / " +
      "NEXT_PUBLIC_AUTOSHIELD_ADDRESS configured. Run a deploy script first.",
  );
} else if (!reachable) {
  console.warn(
    `live chain tests SKIPPED: addresses are configured for ${networkName()}, ` +
      `but no node answered at ${rpcUrl()}.`,
  );
}

describe.skipIf(!reachable)(`live chain reads (${networkName()})`, () => {
  let service: AutoShieldService;

  beforeAll(() => {
    if (!addresses) throw new Error("unreachable: suite is skipped without addresses");
    service = new AutoShieldService(createReadClient().client, addresses);
  });

  it("reads protocol status from the chain", async () => {
    const status = await service.protocolStatus();
    expect(["NORMAL", "RESTRICTED", "HALTED"]).toContain(status.mode);
    expect(status.nowTs).toBeGreaterThan(0);
    // Repayment is never blocked in any mode -- the anti-brick guarantee,
    // checked here against the deployed contract rather than a fixture.
    expect(status.repayEnabled).toBe(true);
  });

  it("reads telemetry with coherent accounting", async () => {
    const telemetry = await service.protocolTelemetry();
    expect(telemetry.totalDepositsAtto).toBeGreaterThanOrEqual(0n);
    expect(telemetry.totalBorrowedAtto).toBeLessThanOrEqual(telemetry.totalDepositsAtto);
  });

  it("reads the shield config and finds it wired to the protocol", async () => {
    const config = await service.shieldConfig();
    expect(config.protocolAddress.toLowerCase()).toBe(addresses!.protocol.toLowerCase());
    expect(config.evaluator).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("reads the incident list without inventing entries", async () => {
    const ids = await service.incidentIds();
    expect(Array.isArray(ids)).toBe(true);
    for (const id of ids) expect(typeof id).toBe("string");
  });

  it("asks the contract itself for the policy result", async () => {
    // The console must never derive a level locally. preview_level is the
    // contract's own view of derive_level(), so the answer here is the
    // contract's, not the console's.
    expect(await service.previewLevel(10, 0)).toBe("SAFE");
    expect(await service.previewLevel(100, 0)).toBe("PROTECT");
  });
});
