import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectionBar } from "@/components/wallet/ConnectionBar";
import { ProtocolCard } from "@/components/protocol/ProtocolCard";
import { RolePanel } from "@/components/wallet/RolePanel";
import { ProtectionState } from "@/components/protocol/ProtectionState";
import { ValidatorPanel } from "@/components/validators/ValidatorPanel";
import { IncidentCard, TransactionStatusLine } from "@/components/incident/IncidentCard";
import { DecisionPanel } from "@/components/incident/DecisionPanel";
import { decodeIncident, decodeStatus, decodeTelemetry } from "@/lib/contracts/decode";
import type {
  ConnectionState,
  ConsensusOutcome,
  ConsoleMode,
  Incident,
  TransactionPhase,
  TransactionState,
} from "@/lib/types";

const NOW = 1_800_000_000;

function incidentFixture(overrides: Record<string, unknown> = {}): Incident {
  return decodeIncident({
    incident_id: "INC-3",
    protocol: "0x1111111111111111111111111111111111111111",
    reporter: "0x2222222222222222222222222222222222222222",
    category: "ORACLE_DEVIATION",
    evidence_hash: "0xabcdef0123456789",
    evidence_uri: "ipfs://evidence",
    metadata_json: '{"deviation_bps": 4100}',
    observed_at_ts: NOW - 30,
    created_at_ts: NOW - 20,
    status: "EVALUATED",
    severity: 92,
    signals_bits: 0b001001,
    level: "HALT",
    evaluated_at_ts: NOW - 10,
    deadline_ts: NOW + 1800,
    executed: false,
    ...overrides,
  });
}

describe("ProtocolCard", () => {
  it("renders protocol state and operation flags", () => {
    render(
      <ProtocolCard
        status={decodeStatus({
          mode: "HALTED",
          borrow_enabled: false,
          supply_enabled: false,
          withdraw_enabled: false,
          repay_enabled: true,
          active_incident_id: "INC-3",
        })}
        telemetry={decodeTelemetry({
          total_deposits_atto: (1_250_000n * 10n ** 18n).toString(),
          total_borrowed_atto: (610_000n * 10n ** 18n).toString(),
          utilisation_bps: 4880,
        })}
        incidentCount={3}
        protocolAddress="0x1111111111111111111111111111111111111111"
      />,
    );

    expect(screen.getByText("DemoLendingProtocol")).toBeInTheDocument();
    expect(screen.getAllByText("HALTED").length).toBeGreaterThan(0);
    expect(screen.getByText("1.25M")).toBeInTheDocument();
    // Repay must always read as enabled.
    expect(screen.getByText("always")).toBeInTheDocument();
  });

  it("renders without data instead of crashing", () => {
    render(
      <ProtocolCard status={null} telemetry={null} incidentCount={0} protocolAddress="—" />,
    );
    expect(screen.getByText("DemoLendingProtocol")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("ProtectionState", () => {
  it.each([
    ["NORMAL", "All operations permitted"],
    ["RESTRICTED", "New borrowing is blocked"],
    ["HALTED", "Repayment stays open"],
  ])("explains %s", (mode, phrase) => {
    render(
      <ProtectionState status={decodeStatus({ mode, seconds_remaining: 0 })} now={NOW} />,
    );
    expect(screen.getByText(new RegExp(phrase, "i"))).toBeInTheDocument();
  });

  it("shows a countdown while a response is active", () => {
    render(
      <ProtectionState
        status={decodeStatus({
          mode: "HALTED",
          seconds_remaining: 1805,
          mode_deadline_ts: NOW + 1805,
        })}
        now={NOW}
      />,
    );
    expect(screen.getByText("Expires in")).toBeInTheDocument();
    expect(screen.getByText("30m 05s")).toBeInTheDocument();
  });
});

describe("ConnectionBar", () => {
  const base: ConnectionState = {
    mode: "chain",
    connected: true,
    address: "0x1111111111111111111111111111111111111111",
    chainId: 61999,
    rpcUrl: "http://127.0.0.1:4000/api",
    error: null,
    warning: null,
  };

  function bar(connection: ConnectionState, mode: ConsoleMode = "chain") {
    return (
      <ConnectionBar
        connection={connection}
        mode={mode}
        onModeChange={() => {}}
        onConnect={() => {}}
        chainAvailable
        busy={false}
      />
    );
  }

  it("shows the chain it is reading", () => {
    render(bar(base));
    expect(screen.getByText("Chain 61999")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("raises an alert on a wrong-network mismatch", () => {
    render(bar({ ...base, warning: "Wrong network: the node reports chain 61127" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Wrong network/);
  });

  it("labels demo mode as simulated rather than as a chain", () => {
    render(bar({ ...base, mode: "demo" }, "demo"));
    expect(screen.getByText("Simulated — no chain")).toBeInTheDocument();
    expect(screen.queryByText(/^Chain /)).not.toBeInTheDocument();
  });
});

describe("RolePanel", () => {
  const observer = {
    address: "0x9999999999999999999999999999999999999999",
    isOwner: false,
    isEvaluator: false,
    isReporter: false,
  };

  it("tells an unprivileged visitor what they can and cannot do", () => {
    render(<RolePanel roles={observer} mode="chain" connected />);
    expect(screen.getByText("Observer")).toBeInTheDocument();
    expect(screen.getByText(/would let anyone flood the protected protocol/))
      .toBeInTheDocument();
    // The permissionless actions stay available even with no roles.
    expect(screen.getByText("Execute an adjudicated response")).toBeInTheDocument();
    expect(screen.getByText("Expire a stale incident")).toBeInTheDocument();
  });

  it("shows every role an operator holds", () => {
    render(
      <RolePanel
        roles={{ ...observer, isOwner: true, isEvaluator: true, isReporter: true }}
        mode="chain"
        connected
      />,
    );
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Evaluator")).toBeInTheDocument();
    expect(screen.getByText("Reporter")).toBeInTheDocument();
    expect(screen.queryByText("Observer")).not.toBeInTheDocument();
  });

  it("says reading needs no wallet when disconnected", () => {
    render(<RolePanel roles={null} mode="chain" connected={false} />);
    expect(screen.getByText(/Reading needs no wallet/)).toBeInTheDocument();
  });

  it("needs no permissions at all in demo mode", () => {
    render(<RolePanel roles={null} mode="demo" connected={false} />);
    expect(screen.getByText(/nothing is signed/)).toBeInTheDocument();
  });
});

describe("ValidatorPanel", () => {
  const chainConsensus: ConsensusOutcome = {
    validators: Array.from({ length: 5 }, (_, index) => ({
      index,
      address: `0x${index.toString(16).padStart(40, "0")}`,
      phase: "agreed",
      executionResult: "SUCCESS",
    })),
    agreeCount: 5,
    totalCount: 5,
    finalized: true,
    fromChain: true,
  };

  it("shows five validators and marks the source as the chain", () => {
    render(<ValidatorPanel consensus={chainConsensus} evaluating={false} />);
    expect(screen.getByText("Validator 1")).toBeInTheDocument();
    expect(screen.getByText("Validator 5")).toBeInTheDocument();
    expect(screen.getAllByText("Evaluated · agreed")).toHaveLength(5);
    expect(screen.getByText("From chain")).toBeInTheDocument();
    expect(screen.queryByText("Simulated")).not.toBeInTheDocument();
  });

  it("labels simulated consensus as simulated", () => {
    render(
      <ValidatorPanel
        consensus={{ ...chainConsensus, fromChain: false }}
        evaluating={false}
      />,
    );
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    expect(screen.queryByText("From chain")).not.toBeInTheDocument();
    expect(screen.getByText(/Demo mode does not run consensus/)).toBeInTheDocument();
  });

  it("shows disagreement distinctly", () => {
    render(
      <ValidatorPanel
        consensus={{
          ...chainConsensus,
          validators: [
            { index: 0, address: "0x0", phase: "disagreed", executionResult: "SUCCESS" },
            { index: 1, address: "0x1", phase: "failed", executionResult: "ERROR" },
          ],
          agreeCount: 0,
          totalCount: 2,
          finalized: false,
        }}
        evaluating={false}
      />,
    );
    expect(screen.getByText("Disagreed")).toBeInTheDocument();
    expect(screen.getByText("Execution failed")).toBeInTheDocument();
  });

  it("shows an evaluating state while adjudication runs", () => {
    render(<ValidatorPanel consensus={null} evaluating />);
    expect(screen.getAllByText("Evaluating")).toHaveLength(5);
  });

  it("is empty before any adjudication", () => {
    render(<ValidatorPanel consensus={null} evaluating={false} />);
    expect(screen.getByText(/Run an adjudication/)).toBeInTheDocument();
  });
});

describe("IncidentCard", () => {
  it("renders the incident fields", () => {
    render(<IncidentCard incident={incidentFixture()} latestTx={null} now={NOW} />);
    expect(screen.getByText("INC-3")).toBeInTheDocument();
    expect(screen.getByText("92 / 100")).toBeInTheDocument();
    expect(screen.getByText("2 of 6")).toBeInTheDocument();
    expect(screen.getByText("30m 00s")).toBeInTheDocument();
  });

  it("shows pending state for an unadjudicated incident", () => {
    render(
      <IncidentCard
        incident={incidentFixture({
          status: "READY",
          level: "",
          severity: 0,
          signals_bits: 0,
          evaluated_at_ts: 0,
          deadline_ts: 0,
        })}
        latestTx={null}
        now={NOW}
      />,
    );
    expect(screen.getByText("not adjudicated")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("handles a missing incident", () => {
    render(<IncidentCard incident={null} latestTx={null} now={NOW} />);
    expect(screen.getByText(/No incident yet/)).toBeInTheDocument();
  });
});

describe("TransactionStatusLine", () => {
  function tx(phase: TransactionPhase, extra: Partial<TransactionState> = {}): TransactionState {
    return {
      id: "t1",
      label: "Adjudicate (GenLayer)",
      phase,
      hash: "0xdeadbeefdeadbeef",
      statusName: "ACCEPTED",
      executionResult: phase === "failed" ? "ERROR" : "SUCCESS",
      error: null,
      startedAt: 0,
      endedAt: null,
      simulated: false,
      ...extra,
    };
  }

  it.each<[TransactionPhase, string]>([
    ["awaiting-wallet", "Awaiting wallet confirmation"],
    ["submitted", "Submitted"],
    ["pending", "Pending / finalizing"],
    ["confirmed", "Confirmed"],
    ["failed", "Failed"],
  ])("renders the %s phase", (phase, label) => {
    render(<TransactionStatusLine tx={tx(phase)} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("never claims success for a submitted transaction", () => {
    render(<TransactionStatusLine tx={tx("submitted")} />);
    expect(screen.queryByText("Confirmed")).not.toBeInTheDocument();
  });

  it("surfaces the error message on failure", () => {
    render(
      <TransactionStatusLine
        tx={tx("failed", { error: "[EXPECTED] Reporter cooldown active" })}
      />,
    );
    expect(screen.getByText(/Reporter cooldown active/)).toBeInTheDocument();
  });

  it("handles no transaction", () => {
    render(<TransactionStatusLine tx={null} />);
    expect(screen.getByText("No transaction in flight.")).toBeInTheDocument();
  });
});

describe("DecisionPanel", () => {
  it("explains a halt", () => {
    render(
      <DecisionPanel incident={incidentFixture()} config={null} derivedLevel="HALT" />,
    );
    expect(screen.getByText("Severity 92 / 100")).toBeInTheDocument();
    expect(screen.getByText(/HALT threshold satisfied/)).toBeInTheDocument();
    expect(screen.getAllByText("HALT").length).toBeGreaterThan(0);
  });

  it("explains a cap at PROTECT when nothing corroborates", () => {
    render(
      <DecisionPanel
        incident={incidentFixture({ severity: 100, signals_bits: 0, level: "PROTECT" })}
        config={null}
        derivedLevel="PROTECT"
      />,
    );
    // Both the rule explanation and the signal summary mention it, which is
    // the point: the operator sees the cause and the consequence.
    expect(screen.getAllByText(/no corroborating signal/)).toHaveLength(2);
    expect(screen.getByText(/capped at PROTECT/)).toBeInTheDocument();
  });

  it("warns when the contract policy view disagrees with the stored level", () => {
    render(
      <DecisionPanel incident={incidentFixture()} config={null} derivedLevel="PROTECT" />,
    );
    expect(screen.getByText(/policy view says PROTECT/)).toBeInTheDocument();
  });

  it("shows nothing to explain before adjudication", () => {
    render(
      <DecisionPanel
        incident={incidentFixture({ level: "", evaluated_at_ts: 0 })}
        config={null}
        derivedLevel=""
      />,
    );
    expect(screen.getByText("Awaiting adjudication.")).toBeInTheDocument();
  });
});
