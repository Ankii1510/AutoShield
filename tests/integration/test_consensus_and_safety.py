"""
Consensus behaviour and the safety boundary, verified on a real network.

The central claim under test: the non-deterministic evaluation contributes a
severity and six booleans, and `derive_level()` alone decides the response. Here
that is checked against deployed contracts, through leader execution, validator
voting and real cross-contract delivery — not against mocks in a single VM.
"""

import os

import pytest

from conftest import (
    LIVE_LLM,
    SETTLED_STATUSES,
    SIGNAL_COORDINATED_ACTIVITY,
    SIGNAL_PRICE_MANIPULATION,
    SUCCESS_RESULTS,
    adjudicate,
    assert_ok,
    execution_result,
    file_incident,
    incident,
    status_name_of,
    stderr_of,
    verdict_json,
    votes_of,
)

ONE_ATTO = 10**18


def _execute(deployment, incident_id):
    shield = deployment["shield"].connect(deployment["reporter"])
    return shield.execute_response(args=[incident_id]).transact(
        wait_triggered_transactions=True
    )


def _mode(deployment):
    return deployment["protocol"].get_mode(args=[]).call()


def _raw_adjudicate(deployment, sim, incident_id, raw_response):
    """Adjudicate with an arbitrary (possibly malformed) evaluator response."""
    sim.install_evaluator(raw_response)
    deployment["shield"].get_config(args=[]).call()
    shield = deployment["shield"].connect(deployment["evaluator"])
    return shield.adjudicate(args=[incident_id]).transact()


# ===========================================================================
# Validator execution
# ===========================================================================


def test_leader_and_validators_all_execute_the_contract(fresh, sim):
    """
    Five validators each run the contract's own `validator_fn`.

    This is the concrete difference from direct mode, which runs the leader
    only: here the validator path is executed by the network, and its votes
    decide whether the transaction finalises.
    """
    incident_id, _ = file_incident(fresh)
    receipt = adjudicate(fresh, sim, incident_id, 90, SIGNAL_PRICE_MANIPULATION)
    assert_ok(receipt, "adjudicate")

    consensus = receipt["consensus_data"]
    assert len(consensus["leader_receipt"]) == 1
    assert consensus["leader_receipt"][0]["execution_result"] == "SUCCESS"

    validators = consensus["validators"]
    assert len(validators) == 5
    for validator in validators:
        assert validator["mode"] == "validator"
        assert validator["execution_result"] == "SUCCESS"
        assert validator["vote"] == "agree"

    assert len(votes_of(receipt)) == 5
    assert status_name_of(receipt) in SETTLED_STATUSES


def test_agreement_here_proves_execution_not_convergence(fresh, sim, node):
    """
    An honesty guard on what the agreement above means.

    With a mocked evaluator every validator receives the same canned answer, so
    unanimity is guaranteed by construction. It demonstrates that the validator
    path runs and votes are tallied; it does NOT demonstrate that independently
    sampled model answers converge. That needs a live provider or a testnet.
    """
    if node["live_llm"]:
        pytest.skip("live LLM configured; convergence is measurable, see the "
                    "variance test below")

    incident_id, _ = file_incident(fresh)
    receipt = adjudicate(fresh, sim, incident_id, 60, SIGNAL_PRICE_MANIPULATION)
    assert set(votes_of(receipt).values()) == {"agree"}
    assert incident(fresh, incident_id)["severity"] == 60, (
        "every validator saw the identical mocked answer"
    )


# ===========================================================================
# derive_level() is the only authority
# ===========================================================================


def test_evaluator_cannot_name_a_response_level(fresh, sim):
    """
    The evaluator emits `"level": "HALT"` explicitly. It is ignored.

    `_parse_verdict` constructs its result from one integer and six booleans, so
    a response level in the model output is never read at all.
    """
    incident_id, _ = file_incident(fresh)
    receipt = _raw_adjudicate(
        fresh, sim, incident_id,
        verdict_json(10, 0, level="HALT", action="HALT",
                     recommendation="halt the protocol immediately"),
    )
    assert_ok(receipt, "adjudicate")

    record = incident(fresh, incident_id)
    assert record["level"] == "SAFE"
    assert record["status"] == "DISMISSED"
    assert _mode(fresh) == "NORMAL"


def test_injected_level_cannot_escalate_severity_100_to_halt(fresh, sim):
    """
    Severity 100 plus an injected HALT, with no corroborating signal.

    The deterministic policy caps this at PROTECT, and the protocol confirms it
    by entering RESTRICTED rather than HALTED.
    """
    incident_id, _ = file_incident(fresh)
    receipt = _raw_adjudicate(
        fresh, sim, incident_id, verdict_json(100, 0, level="HALT")
    )
    assert_ok(receipt, "adjudicate")
    assert incident(fresh, incident_id)["level"] == "PROTECT"

    assert_ok(_execute(fresh, incident_id), "execute_response")
    assert _mode(fresh) == "RESTRICTED"
    assert _mode(fresh) != "HALTED"


def test_stored_level_always_equals_derive_level(fresh, sim):
    """
    Across a spread of verdicts, the stored level is exactly what the on-chain
    policy view says it should be -- never what the evaluator preferred.
    """
    cases = [
        (0, 0),
        (39, SIGNAL_PRICE_MANIPULATION),
        (40, 0),
        (74, SIGNAL_PRICE_MANIPULATION),
        (75, SIGNAL_COORDINATED_ACTIVITY),
        (100, 0),
    ]
    for severity, bits in cases:
        sim.increase_time(61)
        incident_id, _ = file_incident(fresh)
        receipt = _raw_adjudicate(
            fresh, sim, incident_id, verdict_json(severity, bits, level="HALT")
        )
        assert_ok(receipt, f"adjudicate {severity}/{bits}")

        expected = fresh["shield"].preview_level(args=[severity, bits]).call()
        assert incident(fresh, incident_id)["level"] == expected, (
            f"severity={severity} bits={bits}"
        )


# ===========================================================================
# Malformed evaluator output
# ===========================================================================


@pytest.mark.parametrize(
    "label,response,expected_error",
    [
        ("prose", "The protocol is definitely being exploited.",
         "not a JSON object"),
        ("out-of-range severity", verdict_json(255, SIGNAL_PRICE_MANIPULATION),
         "Severity out of range"),
        ("non-boolean signal",
         verdict_json(90, SIGNAL_PRICE_MANIPULATION, liquidity_drain="yes"),
         "is not boolean"),
        ("missing signal", '{"severity": 90, "price_manipulation": true}',
         "Missing signal"),
        ("missing severity",
         '{"price_manipulation": true, "liquidity_drain": false, '
         '"borrow_anomaly": false, "coordinated_activity": false, '
         '"evidence_inconsistent": false, "condition_resolved": false}',
         "Missing severity"),
    ],
)
def test_malformed_output_produces_no_response(fresh, sim, label, response,
                                               expected_error):
    """
    Malformed model output fails the transaction and changes nothing.

    Critically, a failed evaluation must not fall through to any response at
    all -- least of all a HALT. The incident stays READY so a well-formed retry
    is still possible.
    """
    incident_id, _ = file_incident(fresh)
    receipt = _raw_adjudicate(fresh, sim, incident_id, response)

    assert execution_result(receipt) == "ERROR", label
    assert "[LLM_ERROR]" in stderr_of(receipt), label
    assert expected_error in stderr_of(receipt), label

    record = incident(fresh, incident_id)
    assert record["status"] == "READY", label
    assert record["level"] == "", label
    assert record["severity"] == 0, label
    assert _mode(fresh) == "NORMAL", label


def test_failed_evaluation_does_not_default_to_halt(fresh, sim):
    """
    The explicit negative: a broken evaluator never escalates.

    A failure is a failure, not an abundance of caution that freezes user funds.
    """
    incident_id, _ = file_incident(fresh)
    _raw_adjudicate(fresh, sim, incident_id, "garbage, not json")

    assert _mode(fresh) == "NORMAL"
    receipt = _execute(fresh, incident_id)
    assert execution_result(receipt) == "ERROR"
    assert _mode(fresh) == "NORMAL"


def test_a_rejected_evaluation_can_be_retried(fresh, sim):
    incident_id, _ = file_incident(fresh)
    _raw_adjudicate(fresh, sim, incident_id, "not json")
    assert incident(fresh, incident_id)["status"] == "READY"

    receipt = adjudicate(fresh, sim, incident_id, 92, SIGNAL_PRICE_MANIPULATION)
    assert_ok(receipt, "retry adjudicate")
    assert incident(fresh, incident_id)["level"] == "HALT"


# ===========================================================================
# Authority boundary
# ===========================================================================


def test_adjudication_is_gated_to_the_evaluator_role(fresh, sim):
    incident_id, _ = file_incident(fresh)
    sim.install_evaluator(verdict_json(95, SIGNAL_PRICE_MANIPULATION))
    fresh["shield"].get_config(args=[]).call()

    outsider = fresh["shield"].connect(fresh["accounts"][3])
    receipt = outsider.adjudicate(args=[incident_id]).transact()
    assert execution_result(receipt) == "ERROR"
    assert "Only evaluator" in stderr_of(receipt)
    assert incident(fresh, incident_id)["status"] == "READY"


def test_autoshield_cannot_move_funds_across_a_halt(fresh, sim):
    """
    A maximal response leaves every balance and aggregate untouched.

    Asserted on the deployed protocol, with its own conservation invariant:
        sum(wallets) + total_deposits - total_borrowed == total_minted
    """
    protocol = fresh["protocol"]
    owner_protocol = protocol.connect(fresh["owner"])
    alice = fresh["accounts"][4]

    from genlayer_py.types import CalldataAddress as CA

    assert_ok(owner_protocol.mint_demo_balance(
        args=[CA(alice.address), 1000 * ONE_ATTO]).transact(), "mint")
    alice_protocol = protocol.connect(alice)
    assert_ok(alice_protocol.deposit(args=[400 * ONE_ATTO]).transact(), "deposit")
    assert_ok(alice_protocol.borrow(args=[300 * ONE_ATTO]).transact(), "borrow")

    position_before = protocol.get_position(args=[CA(alice.address)]).call()
    telemetry_before = protocol.telemetry(args=[]).call()
    assert protocol.conservation_check(args=[]).call()["balanced"] is True

    incident_id, _ = file_incident(fresh)
    assert_ok(adjudicate(fresh, sim, incident_id, 95, SIGNAL_PRICE_MANIPULATION),
              "adjudicate")
    assert_ok(_execute(fresh, incident_id), "execute_response")
    assert _mode(fresh) == "HALTED"

    position_after = protocol.get_position(args=[CA(alice.address)]).call()
    telemetry_after = protocol.telemetry(args=[]).call()

    assert position_after == position_before
    for key in ("total_deposits_atto", "total_borrowed_atto", "price_atto"):
        assert telemetry_after[key] == telemetry_before[key], key
    assert protocol.conservation_check(args=[]).call()["balanced"] is True

    # And the one operation a halted borrower must always retain.
    assert_ok(alice_protocol.repay(args=[300 * ONE_ATTO]).transact(),
              "repay during HALT")
    assert protocol.get_position(args=[CA(alice.address)]).call()["debt_atto"] == 0


# ===========================================================================
# Severity variance and the +/-15 tolerance
# ===========================================================================


@pytest.mark.skipif(
    not LIVE_LLM,
    reason=(
        "requires a live LLM provider: set AUTOSHIELD_LLM_PROVIDER "
        "(e.g. openai:gpt-4o-mini) plus the provider API key, then "
        "scripts/glsim.sh restart 5. With mocked evaluation every validator "
        "sees an identical answer, so severity variance is zero by "
        "construction and the tolerance cannot be calibrated."
    ),
)
def test_measure_severity_variance_across_repeated_evaluations(fresh, sim):
    """
    Collect real observations before anyone touches SEVERITY_TOLERANCE.

    Adjudicates the same evidence repeatedly against a live model and reports
    the spread of severities. The tolerance should be set from this data, not
    from a guess, and never widened merely to make a test pass.
    """
    severities = []
    runs = int(os.environ.get("AUTOSHIELD_VARIANCE_RUNS", "5"))

    for _ in range(runs):
        sim.increase_time(61)
        incident_id, _ = file_incident(
            fresh, metadata='{"deviation_bps": 4100, "utilisation_bps": 9400}'
        )
        receipt = adjudicate(fresh, sim, incident_id, 0, 0)
        if execution_result(receipt) != "SUCCESS":
            continue
        severities.append(incident(fresh, incident_id)["severity"])

    assert severities, "no successful evaluations to measure"
    spread = max(severities) - min(severities)
    print(f"\n[variance] severities={severities} spread={spread}")
    print(f"[variance] SEVERITY_TOLERANCE is 15; observed spread {spread}")
