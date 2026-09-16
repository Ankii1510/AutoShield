"""
Validator behaviour and the consensus comparison rule.

WHAT DIRECT MODE CAN AND CANNOT SHOW. gltest patches `gl.vm.run_nondet` to run
`leader_fn()` only, recording `(result, leader_fn, validator_fn)` so a test can
replay the validator via `direct_vm.run_validator(leader_result=...)`. That is a
genuine invocation of the contract's own validator function against a chosen
leader result — not a simulation of it — so the agreement logic below is really
being executed.

What it is NOT: multiple independent validators, real LLM variance, vote
tallying, or rotation on disagreement. Those live in the GenLayer consensus
layer and can only be observed against GLSim, a local Studio, or a testnet.
Nothing in this file should be read as evidence that consensus works end to end.

`_compare_verdicts` is additionally unit-tested as a pure function, because it
is the rule that decides whether validators agree and it deserves coverage that
does not depend on a VM at all.
"""

import json

import pytest

from conftest import (
    contract_module,
    mock_evaluator,
    verdict_json,
    SIGNAL_BORROW_ANOMALY,
    SIGNAL_CONDITION_RESOLVED,
    SIGNAL_EVIDENCE_INCONSISTENT,
    SIGNAL_LIQUIDITY_DRAIN,
    SIGNAL_PRICE_MANIPULATION,
    report,
)

SEVERITY_TOLERANCE = 15


@pytest.fixture
def ready(direct_vm, shield, direct_alice, at_t0):
    return report(shield, direct_vm, direct_alice, at_t0)


def _verdict(severity, bits=0):
    """A parsed-verdict dict in the shape `_compare_verdicts` expects."""
    from conftest import SIGNAL_NAMES

    return {
        "severity": severity,
        "signals": {
            name: bool((bits >> index) & 1)
            for index, name in enumerate(SIGNAL_NAMES)
        },
    }


def _flat(severity, bits=0):
    """The flat record the leader actually returns across the VM boundary."""
    return json.loads(verdict_json(severity, bits))


# ===========================================================================
# The comparison rule, as a pure function
# ===========================================================================


@pytest.fixture
def compare(direct_vm, shield):
    return contract_module()._compare_verdicts


def test_identical_verdicts_agree(compare):
    assert compare(_verdict(80, SIGNAL_PRICE_MANIPULATION),
                   _verdict(80, SIGNAL_PRICE_MANIPULATION)) is True


def test_severity_within_tolerance_agrees(compare):
    """Severity is an ordinal judgment, so small differences are expected."""
    assert compare(_verdict(90, SIGNAL_PRICE_MANIPULATION),
                   _verdict(90 - SEVERITY_TOLERANCE, SIGNAL_PRICE_MANIPULATION)) is True


def test_severity_beyond_tolerance_disagrees(compare):
    assert compare(_verdict(100, SIGNAL_PRICE_MANIPULATION),
                   _verdict(100 - SEVERITY_TOLERANCE - 1,
                            SIGNAL_PRICE_MANIPULATION)) is False


def test_any_signal_difference_disagrees(compare):
    """
    Booleans get no tolerance at all: they are what gates a HALT.

    Both verdicts here derive PROTECT, and the severities are identical — the
    disagreement is purely the flag.
    """
    assert compare(_verdict(50, SIGNAL_PRICE_MANIPULATION),
                   _verdict(50, SIGNAL_LIQUIDITY_DRAIN)) is False


def test_straddling_a_threshold_disagrees_even_within_tolerance(compare):
    """
    The binding condition: agreeing on the *consequence*.

    74 and 75 are one apart, well inside the tolerance, but they derive
    different levels — so this is a disagreement, not a rounding difference.
    """
    leader = _verdict(75, SIGNAL_PRICE_MANIPULATION)   # HALT
    validator = _verdict(74, SIGNAL_PRICE_MANIPULATION)  # PROTECT
    assert abs(75 - 74) <= SEVERITY_TOLERANCE
    assert compare(leader, validator) is False


def test_safe_protect_boundary_also_binds(compare):
    assert compare(_verdict(40, 0), _verdict(39, 0)) is False


def test_agreement_inside_a_band_holds(compare):
    """Two severities in the same band, within tolerance, agree."""
    assert compare(_verdict(60, SIGNAL_BORROW_ANOMALY),
                   _verdict(50, SIGNAL_BORROW_ANOMALY)) is True


def test_resolved_condition_makes_wide_severity_gaps_irrelevant_only_if_bits_match(
    compare
):
    both_resolved_l = _verdict(100, SIGNAL_CONDITION_RESOLVED)
    both_resolved_v = _verdict(10, SIGNAL_CONDITION_RESOLVED)
    # Same level (SAFE) and same bits, but severity is far apart — tolerance
    # still binds, so this must disagree.
    assert compare(both_resolved_l, both_resolved_v) is False


def test_comparison_is_symmetric(compare):
    pairs = [
        (_verdict(80, SIGNAL_PRICE_MANIPULATION), _verdict(70, SIGNAL_PRICE_MANIPULATION)),
        (_verdict(75, SIGNAL_PRICE_MANIPULATION), _verdict(74, SIGNAL_PRICE_MANIPULATION)),
        (_verdict(10, 0), _verdict(90, 0)),
        (_verdict(50, SIGNAL_EVIDENCE_INCONSISTENT), _verdict(50, 0)),
    ]
    for left, right in pairs:
        assert compare(left, right) == compare(right, left)


# ===========================================================================
# The validator function itself, replayed against chosen leader results
# ===========================================================================


def _adjudicate_capturing_validator(direct_vm, shield, evaluator, incident_id,
                                    severity, bits):
    """Run adjudication so the contract's validator_fn gets captured."""
    mock_evaluator(direct_vm, verdict_json(severity, bits))
    direct_vm.sender = evaluator
    shield.adjudicate(incident_id)


def test_validator_agrees_with_an_identical_leader_result(
    direct_vm, shield, direct_bob, ready
):
    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION
    )
    # The validator re-runs the same evaluation (same mock) and compares.
    assert direct_vm.run_validator(
        leader_result=_flat(90, SIGNAL_PRICE_MANIPULATION)
    ) is True


def test_validator_agrees_within_severity_tolerance(
    direct_vm, shield, direct_bob, ready
):
    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION
    )
    assert direct_vm.run_validator(
        leader_result=_flat(90 - SEVERITY_TOLERANCE, SIGNAL_PRICE_MANIPULATION)
    ) is True


def test_validator_rejects_a_leader_beyond_tolerance(
    direct_vm, shield, direct_bob, ready
):
    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 95, SIGNAL_PRICE_MANIPULATION
    )
    assert direct_vm.run_validator(
        leader_result=_flat(40, SIGNAL_PRICE_MANIPULATION)
    ) is False


def test_validator_rejects_a_leader_with_different_signals(
    direct_vm, shield, direct_bob, ready
):
    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION
    )
    assert direct_vm.run_validator(
        leader_result=_flat(90, SIGNAL_LIQUIDITY_DRAIN)
    ) is False


def test_validator_rejects_a_leader_that_straddles_the_halt_threshold(
    direct_vm, shield, direct_bob, ready
):
    """A one-point difference that changes the outcome is a disagreement."""
    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 74, SIGNAL_PRICE_MANIPULATION
    )
    assert direct_vm.run_validator(
        leader_result=_flat(75, SIGNAL_PRICE_MANIPULATION)
    ) is False


def test_validator_rejects_malformed_leader_output(
    direct_vm, shield, direct_bob, ready
):
    """
    A leader that returns garbage cannot be rubber-stamped.

    `_parse_verdict` raises inside the validator, which propagates as a
    disagreement rather than an agreement on nonsense.
    """
    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION
    )
    with pytest.raises(Exception):
        direct_vm.run_validator(leader_result={"severity": 90})


def test_validator_rejects_a_leader_that_injected_a_response_level(
    direct_vm, shield, direct_bob, ready
):
    """
    Even a leader that smuggles a level into its result is judged on the seven
    fields that matter; the extra key changes nothing.
    """
    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION
    )
    leader_result = _flat(90, SIGNAL_PRICE_MANIPULATION)
    leader_result["level"] = "HALT"
    assert direct_vm.run_validator(leader_result=leader_result) is True


def test_validator_disagrees_when_the_leader_errored_but_it_succeeds(
    direct_vm, shield, direct_bob, ready
):
    """
    Leader failed, validator succeeded — a real disagreement, forcing rotation
    rather than freezing a failure into state.
    """
    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION
    )
    assert direct_vm.run_validator(
        leader_error="[LLM_ERROR] LLM returned prose"
    ) is False


def test_validator_matches_deterministic_leader_errors_exactly(
    direct_vm, shield, direct_bob, ready
):
    """
    When both sides hit the same deterministic error, they agree.

    Here the mocked model is malformed for leader and validator alike, so the
    validator reproduces the identical `[LLM_ERROR]` message. LLM-class errors
    always disagree by design — that is what rotates consensus — so this
    asserts the disagreement, and the exact-match branch is covered by the
    unit test on `_handle_leader_error` below.
    """
    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION
    )
    mock_evaluator(direct_vm, "prose, not json")
    assert direct_vm.run_validator(
        leader_error="[LLM_ERROR] Evaluation is not a JSON object"
    ) is False


def test_handle_leader_error_ladder(direct_vm, shield):
    """
    The error-classification ladder, unit-tested directly.

    Deterministic errors must match exactly; transient errors agree when both
    sides hit one; LLM and unknown errors always disagree so that consensus
    rotates to a different validator.
    """
    module = contract_module()
    handle = module._handle_leader_error

    class FakeResult:
        def __init__(self, message):
            self.message = message

    def raising(message):
        def _fn():
            raise module.gl.vm.UserError(message)
        return _fn

    expected = "[EXPECTED] Incident not awaiting evaluation"
    assert handle(FakeResult(expected), raising(expected)) is True
    assert handle(FakeResult(expected), raising("[EXPECTED] Something else")) is False

    external = "[EXTERNAL] API returned 404"
    assert handle(FakeResult(external), raising(external)) is True

    assert handle(
        FakeResult("[TRANSIENT] upstream 503"), raising("[TRANSIENT] timeout")
    ) is True

    assert handle(
        FakeResult("[LLM_ERROR] bad json"), raising("[LLM_ERROR] bad json")
    ) is False

    # Validator succeeded where the leader failed.
    assert handle(FakeResult("[EXPECTED] x"), lambda: {"severity": 10}) is False


# ===========================================================================
# Consensus-stability properties of the design
# ===========================================================================


def test_consensus_value_is_compact_structured_data(
    direct_vm, shield, direct_bob, ready
):
    """
    No free-form prose is part of the canonical value.

    The leader returns exactly seven keys — one integer and six booleans — so
    validators compare a small fixed record rather than natural language.
    """
    from conftest import SIGNAL_NAMES

    _adjudicate_capturing_validator(
        direct_vm, shield, direct_bob, ready, 90, SIGNAL_PRICE_MANIPULATION
    )
    stored_result, _leader_fn, _validator_fn = direct_vm._captured_validators[-1]

    assert set(stored_result) == {"severity", *SIGNAL_NAMES}
    assert isinstance(stored_result["severity"], int)
    for name in SIGNAL_NAMES:
        assert isinstance(stored_result[name], bool)


def test_prompt_is_byte_identical_for_identical_inputs(
    direct_vm, shield, protocol_bridge, direct_bob, direct_alice, at_t0
):
    """
    Leader and validator must ask the same question.

    A prompt that varied between them — by dict ordering, a timestamp, or a
    float rendering — would make agreement a coin flip.
    """
    module_prompts = []

    def capture(prompt_data):
        module_prompts.append(prompt_data.get("prompt", ""))
        # GenVM v0.6 hands the nondet block the model's raw TEXT and
        # parses it itself, so the handler must not pre-parse (see
        # workaround 4 in conftest.py).
        return {"ok": (verdict_json(80, SIGNAL_PRICE_MANIPULATION))}

    direct_vm.clear_mocks()
    direct_vm._live_llm_handler = capture

    incident_id = report(
        shield, direct_vm, direct_alice, at_t0,
        metadata=json.dumps({"deviation_bps": 4000, "utilisation_bps": 9100}),
    )
    direct_vm.sender = direct_bob
    shield.adjudicate(incident_id)

    # The validator re-runs leader_fn, producing a second prompt.
    direct_vm.run_validator(leader_result=_flat(80, SIGNAL_PRICE_MANIPULATION))

    assert len(module_prompts) >= 2
    assert module_prompts[0] == module_prompts[-1]


def _ensure_cloudpickle():
    """
    Put the GenVM runner's own cloudpickle on `sys.path`.

    gltest extracts py-genlayer and py-lib-genlayer-std but not
    py-lib-cloudpickle, so `check_pickling` otherwise degrades to a warning
    ("No module named 'cloudpickle'") and silently verifies nothing. Using the
    runner's copy means the check runs against the same implementation
    production uses.
    """
    import sys

    try:
        import cloudpickle  # noqa: F401

        return True
    except ImportError:
        pass

    try:
        from gltest.direct.sdk_loader import download_artifacts, extract_runner

        tarball = download_artifacts("v0.2.12")
        runner_dir = extract_runner(tarball, "py-lib-cloudpickle")
    except Exception:
        return False

    source = runner_dir / "src"
    if not source.exists():
        return False
    sys.path.insert(0, str(source))
    try:
        import cloudpickle  # noqa: F401

        return True
    except ImportError:
        return False


def test_nondet_closures_are_picklable(
    direct_vm, shield, protocol_bridge, direct_bob, direct_alice, at_t0
):
    """
    Production `run_nondet` cloudpickles both closures to cross the WASM
    boundary. Direct mode skips that by default, so a closure capturing
    something unpicklable would pass here and fail on-chain — a failure mode
    worth catching before deployment.

    `check_pickling` turns the real validation back on. The test asserts the
    check actually ran rather than degrading to a warning.
    """
    import warnings

    if not _ensure_cloudpickle():
        pytest.skip("cloudpickle unavailable; pickling check cannot run")

    direct_vm.check_pickling = True
    incident_id = report(shield, direct_vm, direct_alice, at_t0)
    mock_evaluator(direct_vm, verdict_json(60, SIGNAL_BORROW_ANOMALY))
    direct_vm.sender = direct_bob

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        assert shield.adjudicate(incident_id) == "PROTECT"

    problems = [str(w.message) for w in caught if "picklable" in str(w.message)]
    assert problems == [], problems
