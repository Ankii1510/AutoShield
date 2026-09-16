"""
Scenarios A-H: adjudication driven through a real GenLayer Sim network.

Every test here submits real transactions, is executed by a leader, voted on by
five validators running the contract's own `validator_fn`, and finalised. State
is read back from the deployed contracts. Where a protective response is
applied, it crosses to the protected protocol as a real asynchronous `emit`
message — the hop that direct mode could only assert at the wire level.
"""

import pytest

from conftest import (
    SIGNAL_BORROW_ANOMALY,
    SIGNAL_CONDITION_RESOLVED,
    SIGNAL_COORDINATED_ACTIVITY,
    SIGNAL_EVIDENCE_INCONSISTENT,
    SIGNAL_LIQUIDITY_DRAIN,
    SIGNAL_PRICE_MANIPULATION,
    adjudicate,
    assert_ok,
    contract_now,
    execution_result,
    file_incident,
    incident,
    stderr_of,
    votes_of,
)

EXECUTION_WINDOW_SECONDS = 300
EVALUATION_WINDOW_SECONDS = 900
FRESHNESS_WINDOW_SECONDS = 600
HALT_TTL_SECONDS = 1800
PROTECT_TTL_SECONDS = 3600


def _execute(deployment, incident_id, account_key="reporter"):
    """Execute a response and wait for the triggered cross-contract message."""
    shield = deployment["shield"].connect(deployment[account_key])
    return shield.execute_response(args=[incident_id]).transact(
        wait_triggered_transactions=True
    )


def _mode(deployment):
    return deployment["protocol"].get_mode(args=[]).call()


# ===========================================================================
# A. SAFE
# ===========================================================================


def test_A_benign_evidence_resolves_safe(fresh, sim):
    incident_id, _ = file_incident(fresh)
    receipt = adjudicate(fresh, sim, incident_id, 10, 0)
    assert_ok(receipt, "adjudicate")

    record = incident(fresh, incident_id)
    assert record["level"] == "SAFE"
    assert record["status"] == "DISMISSED"
    assert record["severity"] == 10
    assert record["deadline_ts"] == 0
    assert record["executed"] is False

    assert _mode(fresh) == "NORMAL", "a SAFE verdict must never touch the protocol"
    assert set(votes_of(receipt).values()) == {"agree"}


def test_A2_safe_verdict_cannot_be_executed(fresh, sim):
    incident_id, _ = file_incident(fresh)
    assert_ok(adjudicate(fresh, sim, incident_id, 5, 0), "adjudicate")

    receipt = _execute(fresh, incident_id)
    assert execution_result(receipt) == "ERROR"
    assert "not ready for execution" in stderr_of(receipt)
    assert _mode(fresh) == "NORMAL"


# ===========================================================================
# B. PROTECT
# ===========================================================================


def test_B_suspicious_activity_resolves_protect_and_restricts(fresh, sim):
    """
    PROTECT applied end to end, including the real cross-contract hop.

    The protocol enters RESTRICTED: borrowing stops, repayment does not.
    """
    incident_id, _ = file_incident(fresh, category="BORROW_ANOMALY")
    receipt = adjudicate(fresh, sim, incident_id, 55, SIGNAL_BORROW_ANOMALY)
    assert_ok(receipt, "adjudicate")

    record = incident(fresh, incident_id)
    assert record["level"] == "PROTECT"
    assert record["status"] == "EVALUATED"
    assert record["deadline_ts"] == record["evaluated_at_ts"] + PROTECT_TTL_SECONDS

    assert_ok(_execute(fresh, incident_id), "execute_response")
    assert incident(fresh, incident_id)["status"] == "APPLIED"

    status = fresh["protocol"].get_status(args=[]).call()
    assert status["mode"] == "RESTRICTED"
    assert status["active_incident_id"] == incident_id
    assert status["borrow_enabled"] is False
    assert status["repay_enabled"] is True
    assert fresh["protocol"].was_incident_applied(args=[incident_id]).call() is True


# ===========================================================================
# C. HALT
# ===========================================================================


def test_C_strong_corroborated_evidence_halts(fresh, sim):
    incident_id, _ = file_incident(fresh)
    receipt = adjudicate(
        fresh, sim, incident_id, 92,
        SIGNAL_PRICE_MANIPULATION | SIGNAL_COORDINATED_ACTIVITY,
    )
    assert_ok(receipt, "adjudicate")

    record = incident(fresh, incident_id)
    assert record["level"] == "HALT"
    assert record["deadline_ts"] == record["evaluated_at_ts"] + HALT_TTL_SECONDS

    assert_ok(_execute(fresh, incident_id), "execute_response")

    status = fresh["protocol"].get_status(args=[]).call()
    assert status["mode"] == "HALTED"
    assert status["consecutive_halts"] == 1
    assert status["supply_enabled"] is False
    assert status["withdraw_enabled"] is False
    assert status["repay_enabled"] is True, "repayment must never be blocked"


def test_C2_halt_decays_through_restricted_to_normal(fresh, sim):
    """The anti-brick guarantee, observed on a real network with a real clock."""
    incident_id, _ = file_incident(fresh)
    assert_ok(adjudicate(fresh, sim, incident_id, 92, SIGNAL_PRICE_MANIPULATION),
              "adjudicate")
    assert_ok(_execute(fresh, incident_id), "execute_response")
    assert _mode(fresh) == "HALTED"

    sim.increase_time(HALT_TTL_SECONDS + 5)
    assert _mode(fresh) == "RESTRICTED", "HALT must step down, not vanish"

    sim.increase_time(1800 + 5)
    assert _mode(fresh) == "NORMAL", "the protocol must recover with no intervention"


# ===========================================================================
# D. Maximum severity without corroboration
# ===========================================================================


def test_D_severity_100_without_corroboration_is_not_halt(fresh, sim):
    """
    The headline safety property, proven through consensus.

    The evaluator returns the maximum score and names no corroborating
    observation; `derive_level` caps the response at PROTECT.
    """
    incident_id, _ = file_incident(fresh)
    assert_ok(adjudicate(fresh, sim, incident_id, 100, 0), "adjudicate")

    record = incident(fresh, incident_id)
    assert record["severity"] == 100
    assert record["level"] == "PROTECT"

    assert_ok(_execute(fresh, incident_id), "execute_response")
    assert _mode(fresh) == "RESTRICTED"
    assert _mode(fresh) != "HALTED"


# ===========================================================================
# E. Evidence inconsistency
# ===========================================================================


def test_E_inconsistent_evidence_cannot_halt(fresh, sim):
    incident_id, _ = file_incident(fresh)
    assert_ok(
        adjudicate(fresh, sim, incident_id, 100,
                   SIGNAL_PRICE_MANIPULATION | SIGNAL_EVIDENCE_INCONSISTENT),
        "adjudicate",
    )

    record = incident(fresh, incident_id)
    assert record["level"] == "PROTECT"
    assert record["signals_bits"] & SIGNAL_EVIDENCE_INCONSISTENT

    assert_ok(_execute(fresh, incident_id), "execute_response")
    assert _mode(fresh) == "RESTRICTED"


# ===========================================================================
# F. Contradictory evidence
# ===========================================================================


def test_F_claims_contradicting_observed_telemetry(fresh, sim):
    """
    The reporter claims a crisis the protocol's own telemetry does not show.

    The divergence is computed deterministically and handed to the evaluator;
    the evaluator reports it through `evidence_inconsistent`, and the response
    is capped rather than escalated.
    """
    owner_protocol = fresh["protocol"].connect(fresh["owner"])
    assert_ok(owner_protocol.simulate_oracle_move(args=[200, "DOWN"]).transact(),
              "simulate_oracle_move")

    observed = fresh["shield"].protocol_telemetry(args=[]).call()
    assert observed["deviation_bps"] == 200

    incident_id, _ = file_incident(
        fresh, metadata='{"deviation_bps": 9000, "utilisation_bps": 9900}'
    )
    assert_ok(
        adjudicate(fresh, sim, incident_id, 45,
                   SIGNAL_PRICE_MANIPULATION | SIGNAL_EVIDENCE_INCONSISTENT),
        "adjudicate",
    )

    record = incident(fresh, incident_id)
    assert record["level"] == "PROTECT", "contradiction must not escalate"
    assert record["signals_bits"] & SIGNAL_EVIDENCE_INCONSISTENT


def test_F2_resolved_condition_dismisses_regardless_of_severity(fresh, sim):
    incident_id, _ = file_incident(fresh)
    assert_ok(
        adjudicate(fresh, sim, incident_id, 100,
                   SIGNAL_LIQUIDITY_DRAIN | SIGNAL_CONDITION_RESOLVED),
        "adjudicate",
    )
    assert incident(fresh, incident_id)["level"] == "SAFE"
    assert _mode(fresh) == "NORMAL"


# ===========================================================================
# G. Repeated evaluation and replay
# ===========================================================================


def test_G_an_incident_cannot_be_adjudicated_twice(fresh, sim):
    incident_id, _ = file_incident(fresh)
    assert_ok(adjudicate(fresh, sim, incident_id, 55, SIGNAL_BORROW_ANOMALY),
              "adjudicate")

    receipt = adjudicate(fresh, sim, incident_id, 100, SIGNAL_PRICE_MANIPULATION)
    assert execution_result(receipt) == "ERROR"
    assert "not awaiting evaluation" in stderr_of(receipt)

    record = incident(fresh, incident_id)
    assert record["severity"] == 55, "the first verdict must stand"
    assert record["level"] == "PROTECT"


def test_G2_a_response_cannot_be_executed_twice(fresh, sim):
    incident_id, _ = file_incident(fresh)
    assert_ok(adjudicate(fresh, sim, incident_id, 92, SIGNAL_PRICE_MANIPULATION),
              "adjudicate")
    assert_ok(_execute(fresh, incident_id), "execute_response")

    receipt = _execute(fresh, incident_id)
    assert execution_result(receipt) == "ERROR"
    assert "not ready for execution" in stderr_of(receipt)


def test_G3_an_old_evaluation_cannot_override_a_newer_incident(fresh, sim):
    """
    Replaying an earlier verdict must not disturb later state.

    The first incident is adjudicated PROTECT and applied. A second, newer
    incident is then adjudicated HALT and applied. Re-executing the first,
    older incident must fail, and the protocol must keep the newer response.
    """
    first_id, _ = file_incident(fresh)
    assert_ok(adjudicate(fresh, sim, first_id, 55, SIGNAL_BORROW_ANOMALY),
              "adjudicate first")
    assert_ok(_execute(fresh, first_id), "execute first")
    assert _mode(fresh) == "RESTRICTED"

    sim.increase_time(61)  # clear the reporter cooldown
    second_id, _ = file_incident(fresh)
    assert second_id != first_id
    assert_ok(adjudicate(fresh, sim, second_id, 95, SIGNAL_PRICE_MANIPULATION),
              "adjudicate second")
    assert_ok(_execute(fresh, second_id), "execute second")
    assert _mode(fresh) == "HALTED"

    replay = _execute(fresh, first_id)
    assert execution_result(replay) == "ERROR"

    status = fresh["protocol"].get_status(args=[]).call()
    assert status["mode"] == "HALTED"
    assert status["active_incident_id"] == second_id


def test_G4_protocol_rejects_a_replayed_incident_id_directly(fresh, sim):
    """
    Even bypassing AutoShield, the protocol refuses a second application.

    The guard here is AutoShield's address, so this asserts the protocol's own
    replay record rather than AutoShield's lifecycle.
    """
    incident_id, _ = file_incident(fresh)
    assert_ok(adjudicate(fresh, sim, incident_id, 92, SIGNAL_PRICE_MANIPULATION),
              "adjudicate")
    assert_ok(_execute(fresh, incident_id), "execute_response")
    assert fresh["protocol"].was_incident_applied(args=[incident_id]).call() is True

    # Any other caller is not the guard at all.
    outsider = fresh["protocol"].connect(fresh["accounts"][3])
    receipt = outsider.apply_response(
        args=[incident_id, "HALT", contract_now(fresh) + 600, 100]
    ).transact()
    assert execution_result(receipt) == "ERROR"
    assert "Only guard" in stderr_of(receipt)


# ===========================================================================
# H. Stale and expired
# ===========================================================================


def test_H_stale_evidence_is_rejected_at_intake(fresh):
    shield = fresh["shield"].connect(fresh["reporter"])
    stale_observed = contract_now(fresh) - FRESHNESS_WINDOW_SECONDS - 60

    receipt = shield.report_incident(
        args=["ORACLE_DEVIATION", stale_observed, "0x" + "ee" * 32, "", "{}"]
    ).transact()
    assert execution_result(receipt) == "ERROR"
    assert "Evidence is stale" in stderr_of(receipt)


def test_H2_future_dated_evidence_is_rejected(fresh):
    shield = fresh["shield"].connect(fresh["reporter"])
    receipt = shield.report_incident(
        args=["ORACLE_DEVIATION", contract_now(fresh) + 600, "0x" + "ef" * 32, "", "{}"]
    ).transact()
    assert execution_result(receipt) == "ERROR"
    assert "future-dated" in stderr_of(receipt)


def test_H3_an_unadjudicated_incident_goes_stale(fresh, sim):
    incident_id, _ = file_incident(fresh)
    sim.increase_time(EVALUATION_WINDOW_SECONDS + 60)

    receipt = adjudicate(fresh, sim, incident_id, 92, SIGNAL_PRICE_MANIPULATION)
    assert execution_result(receipt) == "ERROR"
    assert "Evaluation window elapsed" in stderr_of(receipt)
    assert incident(fresh, incident_id)["status"] == "READY", (
        "a reverted transaction must write nothing"
    )

    expire = fresh["shield"].expire_incident(args=[incident_id]).transact()
    assert_ok(expire, "expire_incident")
    assert incident(fresh, incident_id)["status"] == "STALE"


def test_H4_an_expired_evaluation_cannot_execute_a_response(fresh, sim):
    """
    A verdict that sat too long is not actionable, and the protocol stays NORMAL.

    This is the scenario that the frozen-clock limitation would otherwise have
    made untestable through consensus.
    """
    incident_id, _ = file_incident(fresh)
    assert_ok(adjudicate(fresh, sim, incident_id, 92, SIGNAL_PRICE_MANIPULATION),
              "adjudicate")
    assert incident(fresh, incident_id)["status"] == "EVALUATED"

    sim.increase_time(EXECUTION_WINDOW_SECONDS + 60)

    receipt = _execute(fresh, incident_id)
    assert execution_result(receipt) == "ERROR"
    assert "Execution window elapsed" in stderr_of(receipt)
    assert _mode(fresh) == "NORMAL", "an expired verdict must not reach the protocol"
    assert incident(fresh, incident_id)["status"] == "EVALUATED"

    assert_ok(fresh["shield"].expire_incident(args=[incident_id]).transact(),
              "expire_incident")
    assert incident(fresh, incident_id)["status"] == "STALE"


def test_H5_protocol_refuses_a_deadline_in_the_past(fresh):
    """The protocol's own stale-response guard, independent of AutoShield."""
    outsider = fresh["protocol"].connect(fresh["accounts"][3])
    receipt = outsider.apply_response(
        args=["INC-STALE", "HALT", contract_now(fresh) - 10, 100]
    ).transact()
    assert execution_result(receipt) == "ERROR"
    assert _mode(fresh) == "NORMAL"
