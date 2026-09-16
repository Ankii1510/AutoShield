import { describe, expect, it } from "vitest";

import {
  decodeConfig,
  decodeIncident,
  decodeIncidentIds,
  decodeSignals,
  decodeStatus,
  decodeTelemetry,
  encodeSignals,
  toLevel,
  toMode,
  toStatus,
} from "@/lib/contracts/decode";

/**
 * Decoding is the console's trust boundary: everything from the chain arrives
 * as `unknown`. These tests pin the two behaviours that matter — malformed data
 * degrades safely, and a response level is never invented.
 */

describe("response level decoding", () => {
  it("accepts only the three known levels", () => {
    expect(toLevel("SAFE")).toBe("SAFE");
    expect(toLevel("PROTECT")).toBe("PROTECT");
    expect(toLevel("HALT")).toBe("HALT");
  });

  it("never invents a level from unexpected input", () => {
    // The critical case: garbage must not become an actionable level, and
    // must certainly not become HALT.
    for (const bad of ["halt", "FREEZE", "", null, undefined, 42, {}, ["HALT"]]) {
      expect(toLevel(bad)).toBe("");
    }
  });
});

describe("mode and status decoding", () => {
  it("maps known values", () => {
    expect(toMode("HALTED")).toBe("HALTED");
    expect(toMode("RESTRICTED")).toBe("RESTRICTED");
    expect(toStatus("APPLIED")).toBe("APPLIED");
  });

  it("falls back conservatively on unknown values", () => {
    expect(toMode("EXPLODED")).toBe("NORMAL");
    expect(toStatus("WEIRD")).toBe("READY");
  });
});

describe("signal bitfield", () => {
  it("round-trips", () => {
    const bits = encodeSignals({ price_manipulation: true, borrow_anomaly: true });
    expect(bits).toBe(0b000101);
    const flags = decodeSignals(bits);
    expect(flags.price_manipulation).toBe(true);
    expect(flags.borrow_anomaly).toBe(true);
    expect(flags.liquidity_drain).toBe(false);
    expect(flags.condition_resolved).toBe(false);
  });

  it("decodes every flag position", () => {
    const all = decodeSignals(0b111111);
    expect(Object.values(all).every(Boolean)).toBe(true);
    const none = decodeSignals(0);
    expect(Object.values(none).some(Boolean)).toBe(false);
  });
});

describe("telemetry decoding", () => {
  it("decodes a full payload", () => {
    const t = decodeTelemetry({
      price_atto: "590000000000000000",
      baseline_atto: "1000000000000000000",
      deviation_bps: 4100,
      utilisation_bps: 9400,
      total_deposits_atto: 1000,
      mode: "HALTED",
      now_ts: 1700,
    });
    expect(t.deviationBps).toBe(4100);
    expect(t.priceAtto).toBe(590000000000000000n);
    expect(t.mode).toBe("HALTED");
  });

  it("survives a completely malformed payload", () => {
    const t = decodeTelemetry("not an object");
    expect(t.deviationBps).toBe(0);
    expect(t.priceAtto).toBe(0n);
    expect(t.mode).toBe("NORMAL");
  });

  it("survives partial data", () => {
    const t = decodeTelemetry({ deviation_bps: 200 });
    expect(t.deviationBps).toBe(200);
    expect(t.utilisationBps).toBe(0);
  });
});

describe("incident decoding", () => {
  const base = {
    incident_id: "INC-7",
    protocol: "0xabc",
    reporter: "0xdef",
    category: "ORACLE_DEVIATION",
    evidence_hash: "0xfeed",
    evidence_uri: "ipfs://x",
    metadata_json: '{"deviation_bps": 4100}',
    observed_at_ts: 100,
    created_at_ts: 120,
    status: "EVALUATED",
    severity: 92,
    signals_bits: 0b000001,
    level: "HALT",
    evaluated_at_ts: 130,
    deadline_ts: 1930,
    executed: false,
  };

  it("decodes an adjudicated incident", () => {
    const incident = decodeIncident(base);
    expect(incident.incidentId).toBe("INC-7");
    expect(incident.level).toBe("HALT");
    expect(incident.evaluation).not.toBeNull();
    expect(incident.evaluation?.severity).toBe(92);
    expect(incident.evaluation?.signals.price_manipulation).toBe(true);
  });

  it("reports no evaluation before adjudication", () => {
    const incident = decodeIncident({
      ...base,
      status: "READY",
      level: "",
      severity: 0,
      signals_bits: 0,
      evaluated_at_ts: 0,
    });
    expect(incident.evaluation).toBeNull();
    expect(incident.level).toBe("");
  });

  it("drops an unrecognised level rather than acting on it", () => {
    const incident = decodeIncident({ ...base, level: "SHUTDOWN" });
    expect(incident.level).toBe("");
  });

  it("survives an empty payload", () => {
    const incident = decodeIncident(null);
    expect(incident.incidentId).toBe("");
    expect(incident.evaluation).toBeNull();
    expect(incident.level).toBe("");
    expect(incident.status).toBe("READY");
  });
});

describe("status and config decoding", () => {
  it("keeps repay enabled by default even on malformed input", () => {
    const status = decodeStatus({});
    expect(status.repayEnabled).toBe(true);
    expect(status.mode).toBe("NORMAL");
  });

  it("uses documented thresholds when config is incomplete", () => {
    const config = decodeConfig({});
    expect(config.haltSeverityThreshold).toBe(75);
    expect(config.protectSeverityThreshold).toBe(40);
    expect(config.signalNames).toHaveLength(6);
  });

  it("filters non-string incident ids", () => {
    expect(decodeIncidentIds(["INC-1", 5, null, "INC-2"])).toEqual(["INC-1", "INC-2"]);
    expect(decodeIncidentIds("nope")).toEqual([]);
  });
});
