"use client";

/**
 * The console's single source of truth.
 *
 * One hook owns connection, polling, the transaction log and the demo engine,
 * and hands components plain typed data. Components never reach for the chain
 * themselves, so there is exactly one place where "what is true right now" is
 * decided.
 *
 * Two invariants worth stating explicitly:
 *
 *  - After any write, state is RE-READ from the authoritative source rather
 *    than patched locally. A write's return value is never treated as the new
 *    truth.
 *  - Every transaction moves through idle -> awaiting-wallet -> submitted ->
 *    pending -> confirmed|failed, and only reaches `confirmed` when the node
 *    reports the contract EXECUTED successfully.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AutoShieldService,
  addressesFromEnv,
  type WriteOutcome,
} from "@/lib/contracts/service";
import {
  NETWORKS,
  createReadClient,
  connectWallet,
  networkName,
  reportedChainId,
  rpcUrl,
} from "@/lib/genlayer/client";
import { DemoEngine } from "@/lib/demo/engine";
import type { Scenario } from "@/lib/demo/scenarios";
import { decodeSignals } from "@/lib/contracts/decode";
import type {
  ConnectionState,
  ConsensusOutcome,
  ConsoleMode,
  Incident,
  IncidentTimelineEvent,
  OperatorRoles,
  ProtocolStatus,
  ProtocolTelemetry,
  ResponseLevel,
  ShieldConfig,
  TransactionPhase,
  TransactionState,
} from "@/lib/types";

const POLL_INTERVAL_MS = 4000;

export type FlowStage =
  | "idle"
  | "simulating"
  | "reporting"
  | "adjudicating"
  | "deciding"
  | "responding"
  | "active"
  | "recovered";

export interface AutoShieldView {
  mode: ConsoleMode;
  connection: ConnectionState;
  ready: boolean;
  loading: boolean;
  error: string | null;

  /** Chain time, advanced locally between polls. Pure at render time. */
  now: number;
  status: ProtocolStatus | null;
  telemetry: ProtocolTelemetry | null;
  config: ShieldConfig | null;
  incidents: Incident[];
  currentIncident: Incident | null;
  consensus: ConsensusOutcome | null;
  /** Level the CONTRACT derives for the current evaluation (chain mode). */
  derivedLevel: ResponseLevel | "";

  /** What the connected wallet may actually do, read from the contract. */
  roles: OperatorRoles | null;

  transactions: TransactionState[];
  timeline: IncidentTimelineEvent[];
  stage: FlowStage;
  busy: boolean;
  selectedScenarioId: string;

  setMode: (mode: ConsoleMode) => void;
  selectScenario: (id: string) => void;
  connect: () => Promise<void>;
  refresh: () => Promise<void>;
  runSimulation: (scenario: Scenario) => Promise<void>;
  reportIncident: (scenario: Scenario) => Promise<void>;
  adjudicate: () => Promise<void>;
  executeResponse: () => Promise<void>;
  clearResponse: () => Promise<void>;
  resetSimulation: () => Promise<void>;
  runFullDemo: (scenario: Scenario) => Promise<void>;
  fastForward: () => void;
  selectIncident: (id: string) => void;
}

function txId(): string {
  return `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useAutoShield(): AutoShieldView {
  const configuredAddresses = useMemo(() => addressesFromEnv(), []);
  const [mode, setModeState] = useState<ConsoleMode>(
    configuredAddresses ? "chain" : "demo",
  );

  const demo = useRef<DemoEngine>(new DemoEngine());
  const serviceRef = useRef<AutoShieldService | null>(null);

  // Network verification verdict, held in a ref so the write gate reads the
  // current value rather than one captured when a callback was created.
  // "pending" until the node has answered; writes are refused on "mismatch".
  const networkRef = useRef<{
    verdict: "pending" | "ok" | "mismatch";
    message: string | null;
  }>({ verdict: "pending", message: null });

  const [connection, setConnection] = useState<ConnectionState>({
    mode: configuredAddresses ? "chain" : "demo",
    connected: false,
    address: null,
    chainId: null,
    rpcUrl: rpcUrl(),
    error: null,
    warning: null,
  });

  const [status, setStatus] = useState<ProtocolStatus | null>(null);
  const [telemetry, setTelemetry] = useState<ProtocolTelemetry | null>(null);
  const [config, setConfig] = useState<ShieldConfig | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [consensus, setConsensus] = useState<ConsensusOutcome | null>(null);
  const [derivedLevel, setDerivedLevel] = useState<ResponseLevel | "">("");
  const [transactions, setTransactions] = useState<TransactionState[]>([]);
  const [timeline, setTimeline] = useState<IncidentTimelineEvent[]>([]);
  const [stage, setStage] = useState<FlowStage>("idle");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState<string>("critical");
  const [roles, setRoles] = useState<OperatorRoles | null>(null);
  const addressRef = useRef<string | null>(null);

  // One ticking clock for the whole console. `tick` increments every second;
  // `anchor` records the chain time of the last successful poll together with
  // the tick it arrived on. Rendering then derives "now" by arithmetic only,
  // never by calling Date.now() during render (which React 19 rejects as
  // impure, and which would drift between components).
  const [tick, setTick] = useState(0);
  const [anchor, setAnchor] = useState<{ chainTs: number; tick: number }>({
    chainTs: 0,
    tick: 0,
  });

  // A monotonically increasing token so a slow poll can never overwrite the
  // result of a newer one (the classic stale-read race).
  const readToken = useRef(0);
  const tickRef = useRef(0);
  tickRef.current = tick;
  addressRef.current = connection.address;

  useEffect(() => {
    const handle = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(handle);
  }, []);

  // ------------------------------------------------------------- helpers

  const pushEvent = useCallback(
    (event: Omit<IncidentTimelineEvent, "id" | "ts"> & { ts?: number }) => {
      setTimeline((prev) => [
        ...prev,
        {
          ...event,
          id: `ev-${prev.length}-${Date.now().toString(36)}`,
          ts: event.ts ?? nowTs(),
        },
      ]);
    },
    [],
  );

  const startTx = useCallback((label: string, simulated: boolean): string => {
    const id = txId();
    setTransactions((prev) => [
      {
        id,
        label,
        phase: simulated ? "submitted" : "awaiting-wallet",
        hash: null,
        statusName: null,
        executionResult: null,
        error: null,
        startedAt: Date.now(),
        endedAt: null,
        simulated,
      },
      ...prev,
    ]);
    return id;
  }, []);

  /**
   * The single gate every chain write passes through.
   *
   * A wrong-network console must refuse to act, not merely say so: signing
   * against the network you did not mean to is the one mistake here that
   * cannot be taken back. Reads are left running so the operator can see what
   * they are actually connected to, and the refusal names the reason.
   */
  const requireService = useCallback((): AutoShieldService => {
    const service = serviceRef.current;
    if (!service) throw new Error("Not connected");
    if (networkRef.current.verdict === "mismatch") {
      throw new Error(
        networkRef.current.message ??
          "Refusing to sign: the connected node is not the configured network.",
      );
    }
    return service;
  }, []);

  const updateTx = useCallback((id: string, patch: Partial<TransactionState>) => {
    setTransactions((prev) =>
      prev.map((tx) => (tx.id === id ? { ...tx, ...patch } : tx)),
    );
  }, []);

  const settleTx = useCallback(
    (id: string, outcome: WriteOutcome) => {
      const phase: TransactionPhase = outcome.succeeded ? "confirmed" : "failed";
      updateTx(id, {
        phase,
        hash: outcome.hash,
        statusName: outcome.statusName,
        executionResult: outcome.executionResult,
        error: outcome.error,
        endedAt: Date.now(),
      });
    },
    [updateTx],
  );

  // --------------------------------------------------------------- reads

  const refresh = useCallback(async () => {
    const token = ++readToken.current;

    if (mode === "demo") {
      const engine = demo.current;
      const list = engine.incidents();
      if (token !== readToken.current) return;
      const engineStatus = engine.status();
      setStatus(engineStatus);
      setTelemetry(engine.telemetry());
      setConfig(engine.config());
      setIncidents(list);
      setAnchor({ chainTs: engineStatus.nowTs, tick: tickRef.current });
      return;
    }

    const service = serviceRef.current;
    if (!service) return;

    try {
      const [nextStatus, nextTelemetry, nextConfig, nextIncidents] = await Promise.all([
        service.protocolStatus(),
        service.protocolTelemetry(),
        service.shieldConfig(),
        service.incidents(),
      ]);
      // Discard if a newer read started while this one was in flight.
      if (token !== readToken.current) return;
      setStatus(nextStatus);
      setTelemetry(nextTelemetry);
      setConfig(nextConfig);
      setIncidents(nextIncidents);
      setAnchor({ chainTs: nextStatus.nowTs, tick: tickRef.current });
      setError(null);

      // What this wallet may do is part of "what is true right now", so it is
      // refreshed with everything else: the owner can change the allowlist or
      // the evaluator at any time, and a stale badge would be a lie.
      const who = addressRef.current;
      if (who) {
        const reporter = await service.isReporter(who);
        if (token !== readToken.current) return;
        setRoles({
          address: who,
          isOwner: nextConfig.owner.toLowerCase() === who.toLowerCase(),
          isEvaluator: nextConfig.evaluator.toLowerCase() === who.toLowerCase(),
          isReporter: reporter,
        });
      } else {
        setRoles(null);
      }
    } catch (err) {
      if (token !== readToken.current) return;
      setError(err instanceof Error ? err.message : "Failed to read contract state");
    }
  }, [mode]);

  // Build the read client once addresses are configured.
  useEffect(() => {
    if (mode !== "chain") {
      serviceRef.current = null;
      setConnection((prev) => ({
        ...prev,
        mode: "demo",
        connected: true,
        error: null,
        warning: null,
      }));
      return;
    }
    if (!configuredAddresses) {
      setConnection((prev) => ({
        ...prev,
        mode: "chain",
        connected: false,
        error:
          "No contract addresses configured. Run scripts/deploy-local.mjs, or use Demo mode.",
        warning: null,
      }));
      return;
    }
    try {
      const bundle = createReadClient();
      serviceRef.current = new AutoShieldService(bundle.client, configuredAddresses);
      setConnection({
        mode: "chain",
        connected: true,
        address: bundle.address,
        chainId: bundle.chainId,
        rpcUrl: rpcUrl(),
        error: null,
        warning: null,
      });
    } catch (err) {
      setConnection((prev) => ({
        ...prev,
        connected: false,
        error: err instanceof Error ? err.message : "Failed to create client",
      }));
    }
  }, [mode, configuredAddresses]);

  // Verify the node is the network we think it is, and refuse to sign if not.
  //
  // A configured network is an assertion. Point the console at a different
  // node and every read still succeeds while describing some other deployment
  // — the quiet version of showing the operator the wrong protocol. Worse, a
  // write would then be signed against a chain nobody chose.
  //
  // The chain id alone cannot settle this: Bradbury and Asimov both report
  // 4221, and the local glsim node runs on 61999, the same id as studionet.
  // So the id is one of two checks. The other is that the endpoint actually
  // being called is the one the named network publishes, which is what
  // separates the two networks that share an id.
  useEffect(() => {
    if (mode !== "chain" || connection.chainId === null) {
      networkRef.current = { verdict: "pending", message: null };
      return;
    }

    const controller = new AbortController();
    const expectedId = connection.chainId;
    const name = networkName();
    const expectedRpc = NETWORKS[name].chain.rpcUrls.default.http[0] ?? "";
    const actualRpc = rpcUrl();

    void (async () => {
      const problems: string[] = [];

      if (name !== "localnet" && expectedRpc !== "" && actualRpc !== expectedRpc) {
        problems.push(
          `the endpoint in use is ${actualRpc}, but ${name} publishes ${expectedRpc}`,
        );
      }

      const actualId = await reportedChainId(controller.signal);
      if (controller.signal.aborted) return;

      if (actualId !== null && actualId !== expectedId) {
        problems.push(
          `the node reports chain ${actualId}, but ${name} is chain ${expectedId}`,
        );
      }

      if (problems.length === 0) {
        networkRef.current = { verdict: "ok", message: null };
        setConnection((prev) =>
          prev.chainId === expectedId && prev.warning ? { ...prev, warning: null } : prev,
        );
        return;
      }

      const message =
        `Wrong network — refusing to sign. Configured for ${name}, but ` +
        `${problems.join("; and ")}. Reads below may belong to a different deployment.`;
      networkRef.current = { verdict: "mismatch", message };
      setConnection((prev) =>
        prev.chainId === expectedId ? { ...prev, warning: message } : prev,
      );
    })();

    return () => controller.abort();
  }, [mode, connection.chainId]);

  useEffect(() => {
    void refresh();
    const handle = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [refresh]);

  const connect = useCallback(async () => {
    if (mode !== "chain" || !configuredAddresses) return;
    setLoading(true);
    try {
      const bundle = await connectWallet();
      serviceRef.current = new AutoShieldService(bundle.client, configuredAddresses);
      setConnection({
        mode: "chain",
        connected: true,
        address: bundle.address,
        chainId: bundle.chainId,
        rpcUrl: rpcUrl(),
        error: null,
        warning: null,
      });
      await refresh();
    } catch (err) {
      setConnection((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : "Wallet connection failed",
      }));
    } finally {
      setLoading(false);
    }
  }, [mode, configuredAddresses, refresh]);

  // -------------------------------------------------------------- writes

  const currentIncident = useMemo(() => {
    if (selectedId) {
      return incidents.find((i) => i.incidentId === selectedId) ?? null;
    }
    return incidents[0] ?? null;
  }, [incidents, selectedId]);

  const runSimulation = useCallback(
    async (scenario: Scenario) => {
      setBusy(true);
      setStage("simulating");
      try {
        if (mode === "demo") {
          const id = startTx(`Simulate: ${scenario.name}`, true);
          await sleep(450);
          demo.current.applyScenario(scenario);
          updateTx(id, { phase: "confirmed", endedAt: Date.now() });
          pushEvent({
            kind: "detection",
            label: "Suspicious activity detected",
            detail: scenario.name,
            simulated: true,
          });
        } else {
          const service = requireService();
          for (const step of scenario.steps) {
            if (step.kind === "reset") {
              const id = startTx("Reset simulation overlay", false);
              updateTx(id, { phase: "submitted" });
              const outcome = await service.resetSimulation();
              settleTx(id, outcome);
              if (!outcome.succeeded) throw new Error(outcome.error ?? "reset failed");
              continue;
            }
            const label =
              step.kind === "oracle"
                ? `Simulate oracle move ${step.magnitudeBps} bps ${step.direction}`
                : step.kind === "borrow"
                  ? `Simulate borrow spike ${step.windowVolumeBps} bps`
                  : step.kind === "liquidity"
                    ? `Simulate liquidity drain ${step.drainBps} bps`
                    : `Simulate tx burst (${step.txCount} tx)`;
            const id = startTx(label, false);
            updateTx(id, { phase: "submitted" });
            const outcome =
              step.kind === "oracle"
                ? await service.simulateOracleMove(step.magnitudeBps, step.direction)
                : step.kind === "borrow"
                  ? await service.simulateBorrowSpike(step.windowVolumeBps)
                  : step.kind === "liquidity"
                    ? await service.simulateLiquidityDrain(step.drainBps)
                    : await service.simulateTxBurst(
                        step.txCount,
                        step.uniqueSenders,
                        step.topSenderShareBps,
                      );
            settleTx(id, outcome);
            if (!outcome.succeeded) throw new Error(outcome.error ?? "simulation failed");
          }
          pushEvent({
            kind: "detection",
            label: "Suspicious activity detected",
            detail: scenario.name,
            simulated: false,
          });
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Simulation failed");
      } finally {
        setBusy(false);
      }
    },
    [mode, pushEvent, refresh, requireService, settleTx, startTx, updateTx],
  );

  const reportIncident = useCallback(
    async (scenario: Scenario) => {
      setBusy(true);
      setStage("reporting");
      try {
        if (mode === "demo") {
          const id = startTx("Report incident", true);
          await sleep(400);
          const incident = demo.current.reportIncident(scenario);
          updateTx(id, { phase: "confirmed", endedAt: Date.now() });
          setSelectedId(incident.incidentId);
          pushEvent({ kind: "incident", label: "Incident created", detail: incident.incidentId, simulated: true });
          pushEvent({
            kind: "evidence",
            label: "Evidence submitted",
            detail: `${incident.evidence.category} · ${incident.evidence.evidenceHash.slice(0, 10)}…`,
            simulated: true,
          });
        } else {
          const service = requireService();
          const chainStatus = await service.protocolStatus();
          const id = startTx("Report incident", false);
          updateTx(id, { phase: "submitted" });
          const outcome = await service.reportIncident({
            category: scenario.category,
            observedAtTs: chainStatus.nowTs,
            evidenceHash: `0x${Date.now().toString(16).padStart(64, "0").slice(-64)}`,
            evidenceUri: `ipfs://autoshield/${scenario.id}`,
            metadataJson: JSON.stringify(scenario.claimed),
          });
          settleTx(id, outcome);
          if (!outcome.succeeded) throw new Error(outcome.error ?? "report failed");

          // Authoritative: ask the contract which incident now exists.
          const ids = await service.incidentIds();
          const newest = ids[ids.length - 1] ?? null;
          setSelectedId(newest);
          pushEvent({ kind: "incident", label: "Incident created", detail: newest ?? "", simulated: false, txHash: outcome.hash });
          pushEvent({ kind: "evidence", label: "Evidence submitted", detail: scenario.category, simulated: false });
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Report failed");
      } finally {
        setBusy(false);
      }
    },
    [mode, pushEvent, refresh, requireService, settleTx, startTx, updateTx],
  );

  const adjudicate = useCallback(async () => {
    const incidentId = currentIncident?.incidentId;
    if (!incidentId) return;

    setBusy(true);
    setStage("adjudicating");
    setConsensus(null);
    try {
      if (mode === "demo") {
        const engine = demo.current;
        const scenario = scenarioId;
        const id = startTx("Adjudicate (GenLayer)", true);
        pushEvent({ kind: "adjudication", label: "GenLayer adjudication started", simulated: true });
        setConsensus(engine.consensus("evaluating"));
        await sleep(1400);
        const { SCENARIOS } = await import("@/lib/demo/scenarios");
        const chosen = SCENARIOS.find((s) => s.id === scenario) ?? SCENARIOS[0]!;
        const verdict = engine.verdictFor(chosen);
        engine.adjudicate(incidentId, verdict.severity, verdict.signalsBits);
        setConsensus(engine.consensus("done"));
        updateTx(id, { phase: "confirmed", endedAt: Date.now() });
        pushEvent({ kind: "consensus", label: "Validators evaluated", detail: "5 of 5 agreed", simulated: true });
        const signals = decodeSignals(verdict.signalsBits);
        const { deriveLevelReference } = await import("@/lib/demo/engine");
        setDerivedLevel(deriveLevelReference(verdict.severity, signals));
        pushEvent({ kind: "decision", label: "Decision finalized", detail: deriveLevelReference(verdict.severity, signals), simulated: true });
      } else {
        const service = requireService();
        const id = startTx("Adjudicate (GenLayer)", false);
        pushEvent({ kind: "adjudication", label: "GenLayer adjudication started", simulated: false });
        updateTx(id, { phase: "submitted" });
        const outcome = await service.adjudicate(incidentId);
        settleTx(id, outcome);
        setConsensus(outcome.consensus);
        if (!outcome.succeeded) throw new Error(outcome.error ?? "adjudication failed");

        if (outcome.consensus) {
          pushEvent({
            kind: "consensus",
            label: "Validators evaluated",
            detail: `${outcome.consensus.agreeCount} of ${outcome.consensus.totalCount} agreed`,
            simulated: false,
            txHash: outcome.hash,
          });
        }

        // Authoritative: read the level the CONTRACT stored, and ask the
        // contract's own policy view to explain it.
        const stored = await service.incident(incidentId);
        if (stored.evaluation) {
          const level = await service.previewLevel(
            stored.evaluation.severity,
            stored.evaluation.signalsBits,
          );
          setDerivedLevel(level);
        }
        pushEvent({ kind: "decision", label: "Decision finalized", detail: stored.level || "—", simulated: false });
      }
      setStage("deciding");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Adjudication failed");
    } finally {
      setBusy(false);
    }
  }, [
    currentIncident,
    mode,
    pushEvent,
    refresh,
    requireService,
    scenarioId,
    settleTx,
    startTx,
    updateTx,
  ]);

  const executeResponse = useCallback(async () => {
    const incidentId = currentIncident?.incidentId;
    if (!incidentId) return;

    setBusy(true);
    setStage("responding");
    try {
      if (mode === "demo") {
        const id = startTx("Execute bounded response", true);
        await sleep(700);
        const applied = demo.current.executeResponse(incidentId);
        updateTx(id, { phase: "confirmed", endedAt: Date.now() });
        pushEvent({
          kind: "response",
          label: `Protocol entered ${applied?.level === "HALT" ? "HALT" : "PROTECT"}`,
          simulated: true,
        });
      } else {
        const service = requireService();
        const id = startTx("Execute bounded response", false);
        updateTx(id, { phase: "submitted" });
        const outcome = await service.executeResponse(incidentId);
        settleTx(id, outcome);
        if (!outcome.succeeded) throw new Error(outcome.error ?? "execution failed");

        // The response reaches the protocol as an asynchronous message.
        updateTx(id, { phase: "pending" });
        await service.waitForTriggered(outcome.hash);
        updateTx(id, { phase: "confirmed", endedAt: Date.now() });

        const applied = await service.protocolStatus();
        pushEvent({
          kind: "response",
          label: `Protocol entered ${applied.mode}`,
          simulated: false,
          txHash: outcome.hash,
        });
      }
      setStage("active");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Execution failed");
    } finally {
      setBusy(false);
    }
  }, [
    currentIncident,
    mode,
    pushEvent,
    refresh,
    requireService,
    settleTx,
    startTx,
    updateTx,
  ]);

  const clearResponse = useCallback(async () => {
    setBusy(true);
    try {
      if (mode === "demo") {
        const id = startTx("Owner override: clear response", true);
        await sleep(300);
        demo.current.clearResponse();
        updateTx(id, { phase: "confirmed", endedAt: Date.now() });
      } else {
        const service = requireService();
        const id = startTx("Owner override: clear response", false);
        updateTx(id, { phase: "submitted" });
        const outcome = await service.clearResponse();
        settleTx(id, outcome);
        if (!outcome.succeeded) throw new Error(outcome.error ?? "clear failed");
      }
      pushEvent({ kind: "recovery", label: "Response cleared by owner", simulated: mode === "demo" });
      setStage("recovered");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setBusy(false);
    }
  }, [mode, pushEvent, refresh, requireService, settleTx, startTx, updateTx]);

  const resetSimulation = useCallback(async () => {
    setBusy(true);
    try {
      if (mode === "demo") {
        demo.current.resetSimulation();
        demo.current.clearResponse();
      } else {
        const service = requireService();
        const id = startTx("Reset simulation overlay", false);
        updateTx(id, { phase: "submitted" });
        const outcome = await service.resetSimulation();
        settleTx(id, outcome);
      }
      setTimeline([]);
      setConsensus(null);
      setDerivedLevel("");
      setStage("idle");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }, [mode, refresh, requireService, settleTx, startTx, updateTx]);

  const fastForward = useCallback(() => {
    if (mode !== "demo") return;
    demo.current.fastForwardToRecovery();
    pushEvent({ kind: "recovery", label: "Response expired — protocol recovering", simulated: true });
    setStage("recovered");
    void refresh();
  }, [mode, pushEvent, refresh]);

  const runFullDemo = useCallback(
    async (scenario: Scenario) => {
      setTimeline([]);
      setConsensus(null);
      setDerivedLevel("");
      await runSimulation(scenario);
      await sleep(250);
      await reportIncident(scenario);
      await sleep(250);
      await adjudicate();
      await sleep(250);
      await executeResponse();
    },
    [adjudicate, executeResponse, reportIncident, runSimulation],
  );

  const setMode = useCallback((next: ConsoleMode) => {
    setModeState(next);
    setTimeline([]);
    setConsensus(null);
    setDerivedLevel("");
    setSelectedId(null);
    setStage("idle");
    setError(null);
  }, []);

  const now = anchor.chainTs > 0 ? anchor.chainTs + (tick - anchor.tick) : 0;

  return {
    mode,
    connection,
    now,
    ready: mode === "demo" || Boolean(configuredAddresses),
    loading,
    error,
    status,
    telemetry,
    config,
    incidents,
    currentIncident,
    consensus,
    derivedLevel,
    roles,
    transactions,
    timeline,
    stage,
    busy,
    selectedScenarioId: scenarioId,
    setMode,
    selectScenario: setScenarioId,
    connect,
    refresh,
    runSimulation,
    reportIncident,
    adjudicate,
    executeResponse,
    clearResponse,
    resetSimulation,
    runFullDemo,
    fastForward,
    selectIncident: setSelectedId,
  };
}
