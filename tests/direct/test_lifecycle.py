"""
Incident lifecycle: evaluation, execution, expiry, and the cross-contract wire.

    READY --evaluate--> EVALUATED --execute--> APPLIED
      |                     |
      |                     +--(window/deadline lapses)--> STALE
      +--(window lapses)--> STALE
    READY --evaluate SAFE--> DISMISSED

The `protocol_bridge` fixture stands in for DemoLendingProtocol (direct mode
allocates every contract at the same storage root, so the two cannot share a
VM). It answers the synchronous telemetry read and captures the asynchronous
`apply_response` message so we can assert exactly what crosses the wire.
"""

import pytest

from conftest import (
    adjudicate_with,
    mock_evaluator,
    verdict_json,
    EVALUATION_WINDOW_SECONDS,
    EXECUTION_WINDOW_SECONDS,
    HALT_TTL_SECONDS,
    PROTECT_TTL_SECONDS,
    SIGNAL_CONDITION_RESOLVED,
    SIGNAL_EVIDENCE_INCONSISTENT,
    SIGNAL_PRICE_MANIPULATION,
    addr,
    report,
)


@pytest.fixture
def ready(direct_vm, shield, direct_alice, at_t0):
    """An incident sitting in READY, ready to be evaluated."""
    return report(shield, direct_vm, direct_alice, at_t0)


def _evaluate(shield, direct_vm, evaluator, incident_id, severity, signals):
    """
    Drive adjudication with a canned evaluator response.

    Phase 3 replaced `record_evaluation(severity, signals)` with
    `adjudicate(incident_id)`, which obtains those same two values from
    `gl.vm.run_nondet(...)`. Every assertion below the call is unchanged,
    because the deterministic handling of the verdict is unchanged.
    """
    return adjudicate_with(shield, direct_vm, evaluator, incident_id, severity, signals)


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def test_evaluation_derives_halt_and_sets_a_deadline(
    direct_vm, shield, direct_bob, ready, at_t0
):
    level = _evaluate(shield, direct_vm, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION)
    assert level == "HALT"

    incident = shield.get_incident(ready)
    assert incident["status"] == "EVALUATED"
    assert incident["level"] == "HALT"
    assert incident["severity"] == 90
    assert incident["signals_bits"] == SIGNAL_PRICE_MANIPULATION
    assert incident["evaluated_at_ts"] == at_t0
    assert incident["deadline_ts"] == at_t0 + HALT_TTL_SECONDS
    assert incident["executed"] is False


def test_evaluation_derives_protect_with_its_own_ttl(
    direct_vm, shield, direct_bob, ready, at_t0
):
    level = _evaluate(shield, direct_vm, direct_bob, ready, 60, SIGNAL_PRICE_MANIPULATION)
    assert level == "PROTECT"
    assert shield.get_incident(ready)["deadline_ts"] == at_t0 + PROTECT_TTL_SECONDS


def test_safe_evaluation_dismisses_without_any_response(
    direct_vm, shield, direct_bob, ready
):
    level = _evaluate(shield, direct_vm, direct_bob, ready, 10, 0)
    assert level == "SAFE"

    incident = shield.get_incident(ready)
    assert incident["status"] == "DISMISSED"
    assert incident["deadline_ts"] == 0
    assert incident["executed"] is False


def test_high_severity_with_resolved_condition_is_dismissed(
    direct_vm, shield, direct_bob, ready
):
    """The policy engine, not the score, decides — asserted through the registry."""
    level = _evaluate(
        shield, direct_vm, direct_bob, ready, 100,
        SIGNAL_PRICE_MANIPULATION | SIGNAL_CONDITION_RESOLVED,
    )
    assert level == "SAFE"
    assert shield.get_incident(ready)["status"] == "DISMISSED"


def test_high_severity_with_inconsistent_evidence_is_capped_at_protect(
    direct_vm, shield, direct_bob, ready
):
    level = _evaluate(
        shield, direct_vm, direct_bob, ready, 100,
        SIGNAL_PRICE_MANIPULATION | SIGNAL_EVIDENCE_INCONSISTENT,
    )
    assert level == "PROTECT"


def test_only_the_evaluator_may_record(direct_vm, shield, direct_alice, ready):
    mock_evaluator(direct_vm, verdict_json(90, SIGNAL_PRICE_MANIPULATION))
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Only evaluator"):
        shield.adjudicate(ready)


def test_owner_is_not_implicitly_the_evaluator(
    direct_vm, shield, direct_owner, ready
):
    mock_evaluator(direct_vm, verdict_json(90, SIGNAL_PRICE_MANIPULATION))
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("Only evaluator"):
        shield.adjudicate(ready)


def test_double_evaluation_is_rejected(direct_vm, shield, direct_bob, ready):
    _evaluate(shield, direct_vm, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION)
    mock_evaluator(direct_vm, verdict_json(10, 0))
    with direct_vm.expect_revert("Incident not awaiting evaluation"):
        shield.adjudicate(ready)


def test_out_of_range_severity_never_reaches_storage(
    direct_vm, shield, direct_bob, ready
):
    mock_evaluator(direct_vm, verdict_json(255, SIGNAL_PRICE_MANIPULATION))
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Severity out of range"):
        shield.adjudicate(ready)
    assert shield.get_incident(ready)["status"] == "READY"


def test_unknown_signal_key_never_reaches_storage(direct_vm, shield, direct_bob, ready):
    """
    An invented signal name cannot widen the closed set.

    The verdict parser builds its result from SIGNAL_NAMES alone, so an extra
    key is not "rejected" so much as never looked at — and a *missing* required
    signal is an LLM error.
    """
    mock_evaluator(
        direct_vm,
        verdict_json(90, SIGNAL_PRICE_MANIPULATION, brand_new_signal=True),
    )
    direct_vm.sender = direct_bob
    assert shield.adjudicate(ready) == "HALT"
    assert shield.get_incident(ready)["signals_bits"] == SIGNAL_PRICE_MANIPULATION


def test_evaluating_an_unknown_incident_is_rejected(direct_vm, shield, direct_bob):
    mock_evaluator(direct_vm, verdict_json(90, SIGNAL_PRICE_MANIPULATION))
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Unknown incident"):
        shield.adjudicate("INC-404")


# ---------------------------------------------------------------------------
# Staleness
# ---------------------------------------------------------------------------


def test_evaluation_after_the_window_is_rejected_without_writing(
    direct_vm, shield, direct_bob, direct_charlie, ready, at_t0, warp
):
    """
    A lapsed incident cannot be evaluated, and the rejection writes nothing.

    A reverting transaction rolls back every write it made, so the contract
    must not try to "mark stale, then raise" — that would be a silent no-op
    on-chain. The incident stays READY until `expire_incident` closes it in a
    transaction that actually commits.
    """
    warp(at_t0 + EVALUATION_WINDOW_SECONDS + 1)
    mock_evaluator(direct_vm, verdict_json(90, SIGNAL_PRICE_MANIPULATION))
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Evaluation window elapsed"):
        shield.adjudicate(ready)

    assert shield.get_incident(ready)["status"] == "READY"

    direct_vm.sender = direct_charlie
    assert shield.expire_incident(ready) == "STALE"


def test_a_lapsed_ready_incident_can_be_expired_by_anyone(
    direct_vm, shield, direct_charlie, ready, at_t0, warp
):
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Incident not yet stale"):
        shield.expire_incident(ready)

    warp(at_t0 + EVALUATION_WINDOW_SECONDS + 1)
    direct_vm.sender = direct_charlie
    assert shield.expire_incident(ready) == "STALE"
    assert shield.get_incident(ready)["status"] == "STALE"


def test_expiring_frees_an_open_incident_slot(
    direct_vm, shield, direct_charlie, ready, at_t0, warp
):
    assert shield.get_config()["open_incident_count"] == 1
    warp(at_t0 + EVALUATION_WINDOW_SECONDS + 1)
    direct_vm.sender = direct_charlie
    shield.expire_incident(ready)
    assert shield.get_config()["open_incident_count"] == 0


def test_a_terminal_incident_cannot_be_expired_again(
    direct_vm, shield, direct_bob, direct_charlie, ready
):
    _evaluate(shield, direct_vm, direct_bob, ready, 10, 0)  # DISMISSED
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Incident already terminal"):
        shield.expire_incident(ready)


# ---------------------------------------------------------------------------
# Execution and the cross-contract wire
# ---------------------------------------------------------------------------


def test_execution_emits_exactly_one_apply_response_message(
    direct_vm, shield, protocol_bridge, direct_bob, direct_charlie, ready, at_t0
):
    protocol_bridge.install(direct_vm)
    _evaluate(shield, direct_vm, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION)

    direct_vm.sender = direct_charlie
    assert shield.execute_response(ready) == "HALT"

    assert len(protocol_bridge.messages) == 1
    message = protocol_bridge.last_message
    assert message["method"] == "apply_response"
    assert message["args"] == [ready, "HALT", at_t0 + HALT_TTL_SECONDS, 90]
    # GenVM v0.6 renamed this stage: v0.5 called it "accepted". The stage is
    # what decides WHEN the queued call lands, so it is asserted rather than
    # left to the SDK default.
    assert message["on"] == "decided"
    # AutoShield holds no value and never sends any.
    assert int(message["value"]) == 0


def test_execution_marks_the_incident_applied(
    direct_vm, shield, protocol_bridge, direct_bob, direct_charlie, ready
):
    protocol_bridge.install(direct_vm)
    _evaluate(shield, direct_vm, direct_bob, ready, 60, SIGNAL_PRICE_MANIPULATION)
    direct_vm.sender = direct_charlie
    shield.execute_response(ready)

    incident = shield.get_incident(ready)
    assert incident["status"] == "APPLIED"
    assert incident["executed"] is True
    assert shield.get_config()["open_incident_count"] == 0


def test_double_execution_is_rejected(
    direct_vm, shield, protocol_bridge, direct_bob, direct_charlie, ready
):
    """A response must reach the protocol at most once."""
    protocol_bridge.install(direct_vm)
    _evaluate(shield, direct_vm, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION)
    direct_vm.sender = direct_charlie
    shield.execute_response(ready)

    with direct_vm.expect_revert("Incident not ready for execution"):
        shield.execute_response(ready)
    assert len(protocol_bridge.messages) == 1


def test_executing_a_dismissed_incident_is_rejected(
    direct_vm, shield, protocol_bridge, direct_bob, direct_charlie, ready
):
    protocol_bridge.install(direct_vm)
    _evaluate(shield, direct_vm, direct_bob, ready, 10, 0)  # SAFE → DISMISSED

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Incident not ready for execution"):
        shield.execute_response(ready)
    assert protocol_bridge.messages == []


def test_executing_an_unevaluated_incident_is_rejected(
    direct_vm, shield, protocol_bridge, direct_charlie, ready
):
    protocol_bridge.install(direct_vm)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Incident not ready for execution"):
        shield.execute_response(ready)
    assert protocol_bridge.messages == []


def test_execution_after_the_window_is_rejected_without_writing(
    direct_vm, shield, protocol_bridge, direct_bob, direct_charlie, ready, at_t0, warp
):
    """
    A verdict that sat around too long must not be actionable.

    This is the stale-response guarantee at the AutoShield end; the protocol
    enforces its own copy of it by rejecting past deadlines. As with a lapsed
    evaluation, the rejection writes nothing — `expire_incident` performs the
    transition in a committing transaction.
    """
    protocol_bridge.install(direct_vm)
    _evaluate(shield, direct_vm, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION)

    warp(at_t0 + EXECUTION_WINDOW_SECONDS + 1)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Execution window elapsed"):
        shield.execute_response(ready)

    assert shield.get_incident(ready)["status"] == "EVALUATED"
    assert protocol_bridge.messages == []

    assert shield.expire_incident(ready) == "STALE"
    assert shield.get_incident(ready)["status"] == "STALE"


def test_execution_is_blocked_while_paused(
    direct_vm, shield, protocol_bridge, direct_owner, direct_bob, direct_charlie, ready
):
    protocol_bridge.install(direct_vm)
    _evaluate(shield, direct_vm, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION)

    direct_vm.sender = direct_owner
    shield.set_paused(True)

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("AutoShield is paused"):
        shield.execute_response(ready)
    assert protocol_bridge.messages == []


def test_evaluated_incident_goes_stale_once_its_deadline_passes(
    direct_vm, shield, direct_bob, direct_charlie, ready, at_t0, warp
):
    _evaluate(shield, direct_vm, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION)
    warp(at_t0 + HALT_TTL_SECONDS + 1)
    direct_vm.sender = direct_charlie
    assert shield.expire_incident(ready) == "STALE"


# ---------------------------------------------------------------------------
# Telemetry read
# ---------------------------------------------------------------------------


def test_shield_reads_live_protocol_telemetry(direct_vm, shield, protocol_bridge):
    """
    AutoShield reads the protocol directly rather than trusting a reporter.

    This synchronous cross-contract view is the foundation of the evidence
    model: claimed metrics are checked against observed ones.
    """
    protocol_bridge.install(direct_vm)
    protocol_bridge.telemetry["deviation_bps"] = 4100
    protocol_bridge.telemetry["utilisation_bps"] = 9200

    telemetry = shield.protocol_telemetry()
    assert telemetry["deviation_bps"] == 4100
    assert telemetry["utilisation_bps"] == 9200


# ---------------------------------------------------------------------------
# Authority boundary
# ---------------------------------------------------------------------------


def test_shield_abi_exposes_no_value_moving_method():
    """
    AutoShield's entire on-chain surface, asserted against the real ABI.

    The authority claim in the architecture document is that AutoShield cannot
    move value: it holds none, no method is payable, and nothing it exposes
    credits, debits or transfers anything. If a method is ever added, this test
    fails and that claim has to be re-argued rather than silently lapsing.
    """
    import json
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, "-m", "genlayer_linter.cli", "schema",
         str(root / "contracts" / "autoshield.py"), "--json"],
        capture_output=True, text=True, cwd=root,
    )
    if result.returncode != 0:
        result = subprocess.run(
            [str(root / ".venv" / "bin" / "genvm-lint"), "schema",
             str(root / "contracts" / "autoshield.py"), "--json"],
            capture_output=True, text=True, cwd=root,
        )
    assert result.returncode == 0, result.stderr

    schema = json.loads(result.stdout)["schema"]
    methods = schema["methods"]

    assert set(methods) == {
        # views
        "preview_level", "decode_signals", "encode_signals", "get_config",
        "get_incident", "list_incidents", "is_reporter", "protocol_telemetry",
        # writes
        "set_reporter", "set_evaluator", "set_paused", "report_incident",
        "adjudicate", "execute_response", "expire_incident",
    }

    # Not one method accepts native value.
    payable = [name for name, spec in methods.items() if spec.get("payable")]
    assert payable == []

    # No __receive__: a plain transfer to AutoShield is rejected by the runtime.
    assert "__receive__" not in methods
