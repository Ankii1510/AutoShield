import { describe, expect, it } from "vitest";

import { deriveLevelReference } from "@/lib/demo/engine";
import { explainRule } from "@/components/incident/DecisionPanel";
import { decodeSignals } from "@/lib/contracts/decode";
import { readConsensus } from "@/lib/contracts/service";
import type { SignalFlags } from "@/lib/types";

/**
 * The demo-mode policy mirror, pinned against the documented contract rules.
 *
 * In chain mode the console asks the contract's own `preview_level` view, so
 * this mirror is never the authority. It is still tested exhaustively, because
 * a demo that showed the wrong outcome would misrepresent the system.
 */

function flags(...on: Array<keyof SignalFlags>): SignalFlags {
  const base = decodeSignals(0);
  for (const name of on) base[name] = true;
  return base;
}

describe("deriveLevelReference", () => {
  it("is SAFE below the protect threshold", () => {
    expect(deriveLevelReference(0, flags("price_manipulation"))).toBe("SAFE");
    expect(deriveLevelReference(39, flags("price_manipulation"))).toBe("SAFE");
  });

  it("is PROTECT in the middle band", () => {
    expect(deriveLevelReference(40, flags())).toBe("PROTECT");
    expect(deriveLevelReference(74, flags("liquidity_drain"))).toBe("PROTECT");
  });

  it("halts only with corroboration", () => {
    expect(deriveLevelReference(75, flags("price_manipulation"))).toBe("HALT");
    expect(deriveLevelReference(100, flags("borrow_anomaly"))).toBe("HALT");
  });

  it("caps maximum severity without corroboration at PROTECT", () => {
    // The headline safety property.
    expect(deriveLevelReference(100, flags())).toBe("PROTECT");
  });

  it("caps inconsistent evidence at PROTECT", () => {
    expect(
      deriveLevelReference(100, flags("price_manipulation", "evidence_inconsistent")),
    ).toBe("PROTECT");
  });

  it("returns SAFE when the condition already resolved", () => {
    expect(
      deriveLevelReference(100, flags("price_manipulation", "condition_resolved")),
    ).toBe("SAFE");
  });

  it("matches an independent restatement across all 64 signal combinations", () => {
    const DECISIVE = [
      "price_manipulation",
      "liquidity_drain",
      "borrow_anomaly",
      "coordinated_activity",
    ] as const;

    for (let bits = 0; bits < 64; bits += 1) {
      const signals = decodeSignals(bits);
      for (const severity of [0, 39, 40, 74, 75, 100]) {
        const expected = (() => {
          if (signals.condition_resolved) return "SAFE";
          const corroborated = DECISIVE.some((n) => signals[n]);
          if (severity >= 75 && corroborated && !signals.evidence_inconsistent)
            return "HALT";
          if (severity >= 40) return "PROTECT";
          return "SAFE";
        })();
        expect(deriveLevelReference(severity, signals)).toBe(expected);
      }
    }
  });
});

describe("explainRule", () => {
  const common = { haltThreshold: 75, protectThreshold: 40 };

  it("explains a satisfied halt", () => {
    expect(
      explainRule({
        ...common,
        severity: 92,
        corroboratingCount: 2,
        inconsistent: false,
        resolved: false,
        level: "HALT",
      }),
    ).toContain("HALT threshold satisfied");
  });

  it("explains a cap caused by missing corroboration", () => {
    expect(
      explainRule({
        ...common,
        severity: 100,
        corroboratingCount: 0,
        inconsistent: false,
        resolved: false,
        level: "PROTECT",
      }),
    ).toContain("no corroborating signal");
  });

  it("explains a cap caused by inconsistency", () => {
    expect(
      explainRule({
        ...common,
        severity: 100,
        corroboratingCount: 1,
        inconsistent: true,
        resolved: false,
        level: "PROTECT",
      }),
    ).toContain("evidence inconsistent");
  });

  it("explains a resolved condition", () => {
    expect(
      explainRule({
        ...common,
        severity: 95,
        corroboratingCount: 3,
        inconsistent: false,
        resolved: true,
        level: "SAFE",
      }),
    ).toContain("condition_resolved");
  });
});

describe("readConsensus", () => {
  it("marks receipt-derived consensus as coming from the chain", () => {
    const outcome = readConsensus({
      consensus_data: {
        final: true,
        votes: {
          "0x00": "agree",
          "0x01": "agree",
          "0x02": "agree",
          "0x03": "agree",
          "0x04": "agree",
        },
        validators: Array.from({ length: 5 }, () => ({ execution_result: "SUCCESS" })),
      },
    });
    expect(outcome?.fromChain).toBe(true);
    expect(outcome?.totalCount).toBe(5);
    expect(outcome?.agreeCount).toBe(5);
    expect(outcome?.validators.every((v) => v.phase === "agreed")).toBe(true);
  });

  it("surfaces disagreement rather than smoothing it over", () => {
    const outcome = readConsensus({
      consensus_data: {
        final: false,
        votes: { "0x00": "agree", "0x01": "disagree", "0x02": "agree" },
        validators: [
          { execution_result: "SUCCESS" },
          { execution_result: "SUCCESS" },
          { execution_result: "SUCCESS" },
        ],
      },
    });
    expect(outcome?.agreeCount).toBe(2);
    expect(outcome?.validators[1]?.phase).toBe("disagreed");
    expect(outcome?.finalized).toBe(false);
  });

  it("marks a failed validator execution", () => {
    const outcome = readConsensus({
      consensus_data: {
        votes: { "0x00": "agree" },
        validators: [{ execution_result: "ERROR" }],
      },
    });
    expect(outcome?.validators[0]?.phase).toBe("failed");
  });

  it("returns null when the receipt carries no consensus data", () => {
    expect(readConsensus({})).toBeNull();
    expect(readConsensus({ consensus_data: { final: true } })).toBeNull();
  });
});
