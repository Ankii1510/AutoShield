"""
The deterministic policy engine: `derive_level(severity, signals) -> level`.

This is the most security-critical pure function in the project — it is the
only place a score becomes a consequence — so it is tested exhaustively rather
than by example.
"""

import pytest

from conftest import (
    ALL_SIGNALS_MASK,
    SIGNAL_BORROW_ANOMALY,
    SIGNAL_CONDITION_RESOLVED,
    SIGNAL_COORDINATED_ACTIVITY,
    SIGNAL_EVIDENCE_INCONSISTENT,
    SIGNAL_LIQUIDITY_DRAIN,
    SIGNAL_PRICE_MANIPULATION,
)

DECISIVE = (
    SIGNAL_PRICE_MANIPULATION,
    SIGNAL_LIQUIDITY_DRAIN,
    SIGNAL_BORROW_ANOMALY,
    SIGNAL_COORDINATED_ACTIVITY,
)


# ---------------------------------------------------------------------------
# Severity boundaries
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("severity", [0, 1, 20, 38, 39])
def test_below_protect_threshold_is_safe(shield, severity):
    assert shield.preview_level(severity, SIGNAL_PRICE_MANIPULATION) == "SAFE"


@pytest.mark.parametrize("severity", [40, 41, 60, 73, 74])
def test_protect_band(shield, severity):
    assert shield.preview_level(severity, SIGNAL_PRICE_MANIPULATION) == "PROTECT"


@pytest.mark.parametrize("severity", [75, 76, 99, 100])
def test_halt_band_requires_only_corroboration(shield, severity):
    assert shield.preview_level(severity, SIGNAL_PRICE_MANIPULATION) == "HALT"


def test_exact_threshold_boundaries(shield):
    """The two boundaries that decide everything, pinned explicitly."""
    assert shield.preview_level(39, SIGNAL_PRICE_MANIPULATION) == "SAFE"
    assert shield.preview_level(40, SIGNAL_PRICE_MANIPULATION) == "PROTECT"
    assert shield.preview_level(74, SIGNAL_PRICE_MANIPULATION) == "PROTECT"
    assert shield.preview_level(75, SIGNAL_PRICE_MANIPULATION) == "HALT"


def test_full_severity_sweep_is_monotonic(shield):
    """
    Across the whole range, with a decisive signal present, the level never
    gets weaker as severity rises.
    """
    rank = {"SAFE": 0, "PROTECT": 1, "HALT": 2}
    previous = 0
    for severity in range(0, 101):
        current = rank[shield.preview_level(severity, SIGNAL_LIQUIDITY_DRAIN)]
        assert current >= previous, f"level regressed at severity {severity}"
        previous = current
    assert previous == 2


# ---------------------------------------------------------------------------
# Signal semantics
# ---------------------------------------------------------------------------


def test_halt_requires_a_decisive_signal(shield):
    """A maximal score with no corroborating observation is capped at PROTECT."""
    assert shield.preview_level(100, 0) == "PROTECT"


@pytest.mark.parametrize("signal", DECISIVE)
def test_each_decisive_signal_unlocks_halt(shield, signal):
    assert shield.preview_level(90, signal) == "HALT"


def test_inconsistent_evidence_caps_at_protect(shield):
    """Evidence that contradicts itself can never freeze the protocol."""
    bits = SIGNAL_PRICE_MANIPULATION | SIGNAL_EVIDENCE_INCONSISTENT
    assert shield.preview_level(100, bits) == "PROTECT"


def test_resolved_condition_is_always_safe(shield):
    """If the condition has already passed, acting is pure false-positive cost."""
    bits = (
        SIGNAL_PRICE_MANIPULATION
        | SIGNAL_LIQUIDITY_DRAIN
        | SIGNAL_BORROW_ANOMALY
        | SIGNAL_COORDINATED_ACTIVITY
        | SIGNAL_CONDITION_RESOLVED
    )
    assert shield.preview_level(100, bits) == "SAFE"


def test_resolved_overrides_inconsistent_and_severity(shield):
    bits = SIGNAL_CONDITION_RESOLVED | SIGNAL_EVIDENCE_INCONSISTENT
    assert shield.preview_level(100, bits) == "SAFE"


def test_exhaustive_signal_combinations_match_the_specification(shield):
    """
    Every one of the 64 signal combinations x representative severities,
    checked against an independent restatement of the documented rules.
    """

    def expected(severity: int, bits: int) -> str:
        if bits & SIGNAL_CONDITION_RESOLVED:
            return "SAFE"
        corroborated = any(bits & flag for flag in DECISIVE)
        inconsistent = bool(bits & SIGNAL_EVIDENCE_INCONSISTENT)
        if severity >= 75 and corroborated and not inconsistent:
            return "HALT"
        if severity >= 40:
            return "PROTECT"
        return "SAFE"

    for bits in range(0, ALL_SIGNALS_MASK + 1):
        for severity in (0, 39, 40, 74, 75, 100):
            assert shield.preview_level(severity, bits) == expected(severity, bits), (
                f"mismatch at severity={severity} bits={bits:06b}"
            )


# ---------------------------------------------------------------------------
# Input validation — the closed set is enforced, not assumed
# ---------------------------------------------------------------------------


def test_severity_above_range_is_rejected(direct_vm, shield):
    with direct_vm.expect_revert("Severity out of range"):
        shield.preview_level(101, 0)


def test_unknown_signal_bit_is_rejected(direct_vm, shield):
    """A bit outside the closed set must not be silently ignored."""
    with direct_vm.expect_revert("Unknown signal flag"):
        shield.preview_level(50, ALL_SIGNALS_MASK + 1)


# ---------------------------------------------------------------------------
# Encoding helpers
# ---------------------------------------------------------------------------


def test_encode_decode_roundtrip(shield):
    bits = shield.encode_signals(True, False, True, False, True, False)
    assert bits == (
        SIGNAL_PRICE_MANIPULATION | SIGNAL_BORROW_ANOMALY | SIGNAL_EVIDENCE_INCONSISTENT
    )
    decoded = shield.decode_signals(bits)
    assert decoded["price_manipulation"] is True
    assert decoded["liquidity_drain"] is False
    assert decoded["borrow_anomaly"] is True
    assert decoded["evidence_inconsistent"] is True
    assert decoded["condition_resolved"] is False


def test_all_signal_names_are_exposed(shield):
    config = shield.get_config()
    assert config["signal_names"] == [
        "price_manipulation",
        "liquidity_drain",
        "borrow_anomaly",
        "coordinated_activity",
        "evidence_inconsistent",
        "condition_resolved",
    ]
    assert config["all_signals_mask"] == ALL_SIGNALS_MASK
