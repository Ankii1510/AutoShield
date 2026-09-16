"""
Emergency-response state machine and the anti-brick guarantees.

This is the most important file in the suite. It is the executable proof that
a false positive cannot permanently disable the protected protocol:

    NORMAL --PROTECT--> RESTRICTED --(deadline)--> NORMAL
    NORMAL --HALT-----> HALTED --(deadline)--> RESTRICTED --(decay)--> NORMAL

with repayment open at every step and every deadline bounded by the protocol
itself rather than by AutoShield's good behaviour.
"""

import pytest

from conftest import (
    HALT_DECAY_TO_RESTRICTED_SECONDS,
    MAX_CONSECUTIVE_HALTS,
    MAX_RESPONSE_TTL_SECONDS,
    ONE_ATTO,
    addr,
)

PROTECT_TTL = 3600
HALT_TTL = 1800


def _apply(protocol, direct_vm, guard, incident_id, level, deadline_ts, severity=80):
    direct_vm.sender = guard
    return protocol.apply_response(incident_id, level, deadline_ts, severity)


@pytest.fixture
def borrowed(direct_vm, funded_protocol, direct_alice):
    """Alice with a real position: 400 supplied, 300 borrowed."""
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    funded_protocol.borrow(300 * ONE_ATTO)
    return funded_protocol


# ---------------------------------------------------------------------------
# Valid transitions
# ---------------------------------------------------------------------------


def test_normal_to_restricted_via_protect(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    applied = _apply(
        guarded_protocol, direct_vm, direct_charlie, "INC-1", "PROTECT",
        at_t0 + PROTECT_TTL, 55,
    )
    assert applied == "PROTECT"

    status = guarded_protocol.get_status()
    assert status["mode"] == "RESTRICTED"
    assert status["active_incident_id"] == "INC-1"
    assert status["mode_deadline_ts"] == at_t0 + PROTECT_TTL
    assert status["borrow_enabled"] is False
    assert status["withdraw_enabled"] is True
    assert status["repay_enabled"] is True


def test_normal_to_halted_via_halt(direct_vm, guarded_protocol, direct_charlie, at_t0):
    applied = _apply(
        guarded_protocol, direct_vm, direct_charlie, "INC-1", "HALT",
        at_t0 + HALT_TTL, 90,
    )
    assert applied == "HALT"

    status = guarded_protocol.get_status()
    assert status["mode"] == "HALTED"
    assert status["consecutive_halts"] == 1
    assert status["borrow_enabled"] is False
    assert status["supply_enabled"] is False
    assert status["withdraw_enabled"] is False
    assert status["repay_enabled"] is True


def test_restricted_escalates_to_halted(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    _apply(guarded_protocol, direct_vm, direct_charlie, "INC-1", "PROTECT", at_t0 + PROTECT_TTL)
    _apply(guarded_protocol, direct_vm, direct_charlie, "INC-2", "HALT", at_t0 + HALT_TTL)

    status = guarded_protocol.get_status()
    assert status["mode"] == "HALTED"
    assert status["active_incident_id"] == "INC-2"


def test_protect_de_escalates_an_active_halt_without_shortening_it(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    """
    A PROTECT arriving during a HALT relaxes the mode but must not let the
    protocol out from under the halt's remaining time any earlier than the
    halt itself would have.
    """
    _apply(guarded_protocol, direct_vm, direct_charlie, "INC-1", "HALT", at_t0 + 3000)
    _apply(guarded_protocol, direct_vm, direct_charlie, "INC-2", "PROTECT", at_t0 + 100)

    status = guarded_protocol.get_status()
    assert status["mode"] == "RESTRICTED"
    assert status["mode_deadline_ts"] == at_t0 + 3000


# ---------------------------------------------------------------------------
# Invalid transitions
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("level", ["SAFE", "FREEZE", "halt", "", "PROTECT "])
def test_unknown_or_non_actionable_levels_are_rejected(
    direct_vm, guarded_protocol, direct_charlie, at_t0, level
):
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Unknown response level"):
        guarded_protocol.apply_response("INC-1", level, at_t0 + 600, 80)


def test_empty_incident_id_is_rejected(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Incident id required"):
        guarded_protocol.apply_response("", "HALT", at_t0 + 600, 80)


def test_severity_out_of_range_is_rejected(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Severity out of range"):
        guarded_protocol.apply_response("INC-1", "HALT", at_t0 + 600, 101)


def test_deadline_in_the_past_is_rejected(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    """A stale response must not be applicable at all."""
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Response already expired"):
        guarded_protocol.apply_response("INC-1", "HALT", at_t0 - 1, 80)


def test_deadline_equal_to_now_is_rejected(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Response already expired"):
        guarded_protocol.apply_response("INC-1", "HALT", at_t0, 80)


# ---------------------------------------------------------------------------
# Bounded authority
# ---------------------------------------------------------------------------


def test_excessive_deadline_is_clamped_not_honoured(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    """
    A guard asking for a year-long halt gets the protocol's ceiling instead.

    The protocol never trusts the deadline it is handed.
    """
    _apply(
        guarded_protocol, direct_vm, direct_charlie, "INC-1", "HALT",
        at_t0 + 365 * 24 * 3600, 100,
    )
    status = guarded_protocol.get_status()
    assert status["mode_deadline_ts"] == at_t0 + MAX_RESPONSE_TTL_SECONDS


def test_halt_chain_is_capped_and_downgraded(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    """
    No sequence of AutoShield actions can chain halts indefinitely.

    After MAX_CONSECUTIVE_HALTS, further HALT requests are downgraded to
    PROTECT until the protocol has returned to NORMAL at least once.
    """
    for index in range(MAX_CONSECUTIVE_HALTS):
        applied = _apply(
            guarded_protocol, direct_vm, direct_charlie,
            f"INC-{index + 1}", "HALT", at_t0 + HALT_TTL, 95,
        )
        assert applied == "HALT"

    assert guarded_protocol.get_status()["consecutive_halts"] == MAX_CONSECUTIVE_HALTS

    downgraded = _apply(
        guarded_protocol, direct_vm, direct_charlie, "INC-99", "HALT",
        at_t0 + HALT_TTL, 100,
    )
    assert downgraded == "PROTECT"
    assert guarded_protocol.get_status()["mode"] == "RESTRICTED"


def test_returning_to_normal_resets_the_escalation_budget(
    direct_vm, guarded_protocol, direct_charlie, at_t0, warp
):
    for index in range(MAX_CONSECUTIVE_HALTS):
        _apply(
            guarded_protocol, direct_vm, direct_charlie,
            f"INC-{index + 1}", "HALT", at_t0 + HALT_TTL, 95,
        )

    # Let the halt lapse all the way back to NORMAL.
    later = warp(at_t0 + HALT_TTL + HALT_DECAY_TO_RESTRICTED_SECONDS + 1)
    assert guarded_protocol.get_mode() == "NORMAL"

    # A write settles the decay and clears the counter.
    _apply(guarded_protocol, direct_vm, direct_charlie, "INC-50", "HALT", later + HALT_TTL, 95)
    assert guarded_protocol.get_status()["consecutive_halts"] == 1


# ---------------------------------------------------------------------------
# Lazy decay — the heart of the anti-brick guarantee
# ---------------------------------------------------------------------------


def test_restricted_decays_to_normal_with_no_transaction(
    direct_vm, guarded_protocol, direct_charlie, at_t0, warp
):
    _apply(guarded_protocol, direct_vm, direct_charlie, "INC-1", "PROTECT", at_t0 + PROTECT_TTL)
    assert guarded_protocol.get_mode() == "RESTRICTED"

    warp(at_t0 + PROTECT_TTL - 1)
    assert guarded_protocol.get_mode() == "RESTRICTED"

    warp(at_t0 + PROTECT_TTL)
    assert guarded_protocol.get_mode() == "NORMAL"


def test_halt_decays_to_restricted_then_normal(
    direct_vm, guarded_protocol, direct_charlie, at_t0, warp
):
    """HALT must never decay straight to NORMAL — it steps down through RESTRICTED."""
    _apply(guarded_protocol, direct_vm, direct_charlie, "INC-1", "HALT", at_t0 + HALT_TTL, 90)
    assert guarded_protocol.get_mode() == "HALTED"

    warp(at_t0 + HALT_TTL - 1)
    assert guarded_protocol.get_mode() == "HALTED"

    warp(at_t0 + HALT_TTL)
    assert guarded_protocol.get_mode() == "RESTRICTED"

    warp(at_t0 + HALT_TTL + HALT_DECAY_TO_RESTRICTED_SECONDS - 1)
    assert guarded_protocol.get_mode() == "RESTRICTED"

    warp(at_t0 + HALT_TTL + HALT_DECAY_TO_RESTRICTED_SECONDS)
    assert guarded_protocol.get_mode() == "NORMAL"


def test_decay_is_persisted_on_the_next_write(
    direct_vm, funded_protocol, direct_charlie, direct_alice, at_t0, warp
):
    """
    Reads compute the decay; the next gated write commits it to storage.

    Both must agree, or the protocol would report a mode it does not enforce.
    """
    _apply(funded_protocol, direct_vm, direct_charlie, "INC-1", "PROTECT", at_t0 + PROTECT_TTL)
    assert funded_protocol.get_status()["stored_mode"] == "RESTRICTED"

    warp(at_t0 + PROTECT_TTL + 1)
    # Read already reflects the decay, but storage has not caught up yet.
    assert funded_protocol.get_status()["mode"] == "NORMAL"
    assert funded_protocol.get_status()["stored_mode"] == "RESTRICTED"

    direct_vm.sender = direct_alice
    funded_protocol.deposit(1 * ONE_ATTO)

    status = funded_protocol.get_status()
    assert status["stored_mode"] == "NORMAL"
    assert status["mode_deadline_ts"] == 0
    assert status["active_incident_id"] == ""


def test_operations_recover_automatically_after_decay(
    direct_vm, borrowed, direct_charlie, direct_alice, at_t0, warp
):
    """
    The whole point: after a false-positive halt, everything works again with
    no intervention from AutoShield, the guard, the owner, or a keeper.
    """
    _apply(borrowed, direct_vm, direct_charlie, "INC-1", "HALT", at_t0 + HALT_TTL, 90)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Borrowing disabled"):
        borrowed.borrow(1 * ONE_ATTO)

    warp(at_t0 + HALT_TTL + HALT_DECAY_TO_RESTRICTED_SECONDS)
    direct_vm.sender = direct_alice
    borrowed.deposit(100 * ONE_ATTO)  # supply works again
    borrowed.borrow(1 * ONE_ATTO)  # borrowing works again
    borrowed.withdraw(1 * ONE_ATTO)  # withdrawals work again, uncapped

    assert borrowed.get_mode() == "NORMAL"
    assert borrowed.get_position(addr(direct_alice))["debt_atto"] == 301 * ONE_ATTO
    assert borrowed.conservation_check()["balanced"] is True


# ---------------------------------------------------------------------------
# Operation gating per mode
# ---------------------------------------------------------------------------


def test_restricted_blocks_borrowing_but_allows_supply(
    direct_vm, borrowed, direct_charlie, direct_bob, at_t0
):
    _apply(borrowed, direct_vm, direct_charlie, "INC-1", "PROTECT", at_t0 + PROTECT_TTL)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Borrowing disabled in RESTRICTED"):
        borrowed.borrow(1 * ONE_ATTO)
    borrowed.deposit(10 * ONE_ATTO)  # supply still allowed


def test_restricted_caps_withdrawals_but_does_not_block_them(
    direct_vm, funded_protocol, direct_charlie, direct_bob, at_t0
):
    direct_vm.sender = direct_bob
    funded_protocol.deposit(500 * ONE_ATTO)

    _apply(funded_protocol, direct_vm, direct_charlie, "INC-1", "PROTECT", at_t0 + PROTECT_TTL)

    direct_vm.sender = direct_bob
    funded_protocol.withdraw(100 * ONE_ATTO)  # 20% of 500 — at the cap

    with direct_vm.expect_revert("exceeds restricted-mode cap"):
        funded_protocol.withdraw(1 * ONE_ATTO)


def test_restricted_cap_cannot_be_walked_past_in_small_steps(
    direct_vm, funded_protocol, direct_charlie, direct_bob, at_t0
):
    direct_vm.sender = direct_bob
    funded_protocol.deposit(500 * ONE_ATTO)
    _apply(funded_protocol, direct_vm, direct_charlie, "INC-1", "PROTECT", at_t0 + PROTECT_TTL)

    direct_vm.sender = direct_bob
    for _ in range(10):
        funded_protocol.withdraw(10 * ONE_ATTO)  # 100 total, exactly the cap

    with direct_vm.expect_revert("exceeds restricted-mode cap"):
        funded_protocol.withdraw(1 * ONE_ATTO)


def test_halt_blocks_supply_withdraw_and_borrow(
    direct_vm, borrowed, direct_charlie, direct_alice, at_t0
):
    _apply(borrowed, direct_vm, direct_charlie, "INC-1", "HALT", at_t0 + HALT_TTL, 90)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Supply disabled while halted"):
        borrowed.deposit(1 * ONE_ATTO)
    with direct_vm.expect_revert("Withdrawals disabled while halted"):
        borrowed.withdraw(1 * ONE_ATTO)
    with direct_vm.expect_revert("Borrowing disabled in HALTED"):
        borrowed.borrow(1 * ONE_ATTO)


# ---------------------------------------------------------------------------
# Repayment is never blocked — in any mode
# ---------------------------------------------------------------------------


def test_repay_works_in_normal(direct_vm, borrowed, direct_alice):
    direct_vm.sender = direct_alice
    borrowed.repay(50 * ONE_ATTO)
    assert borrowed.get_position(addr(direct_alice))["debt_atto"] == 250 * ONE_ATTO


def test_repay_works_in_restricted(
    direct_vm, borrowed, direct_charlie, direct_alice, at_t0
):
    _apply(borrowed, direct_vm, direct_charlie, "INC-1", "PROTECT", at_t0 + PROTECT_TTL)
    direct_vm.sender = direct_alice
    borrowed.repay(50 * ONE_ATTO)
    assert borrowed.get_position(addr(direct_alice))["debt_atto"] == 250 * ONE_ATTO


def test_repay_works_in_halted(
    direct_vm, borrowed, direct_charlie, direct_alice, at_t0
):
    """The guarantee that stops a false HALT causing liquidation damage."""
    _apply(borrowed, direct_vm, direct_charlie, "INC-1", "HALT", at_t0 + HALT_TTL, 100)
    assert borrowed.get_mode() == "HALTED"

    direct_vm.sender = direct_alice
    borrowed.repay(300 * ONE_ATTO)  # full repayment, mid-halt
    assert borrowed.get_position(addr(direct_alice))["debt_atto"] == 0
    assert borrowed.get_mode() == "HALTED"  # still halted; the user just got out
    assert borrowed.conservation_check()["balanced"] is True


def test_repay_works_at_the_escalation_ceiling(
    direct_vm, borrowed, direct_charlie, direct_alice, at_t0
):
    for index in range(MAX_CONSECUTIVE_HALTS):
        _apply(
            borrowed, direct_vm, direct_charlie,
            f"INC-{index + 1}", "HALT", at_t0 + HALT_TTL, 100,
        )
    direct_vm.sender = direct_alice
    borrowed.repay(300 * ONE_ATTO)
    assert borrowed.get_position(addr(direct_alice))["debt_atto"] == 0


# ---------------------------------------------------------------------------
# Owner override
# ---------------------------------------------------------------------------


def test_owner_can_clear_a_false_positive_immediately(
    direct_vm, guarded_protocol, direct_charlie, direct_owner, at_t0
):
    _apply(guarded_protocol, direct_vm, direct_charlie, "INC-1", "HALT", at_t0 + HALT_TTL, 90)
    direct_vm.sender = direct_owner
    guarded_protocol.clear_response()

    status = guarded_protocol.get_status()
    assert status["mode"] == "NORMAL"
    assert status["active_incident_id"] == ""
    assert status["consecutive_halts"] == 0


def test_non_owner_cannot_clear(
    direct_vm, guarded_protocol, direct_charlie, direct_alice, at_t0
):
    _apply(guarded_protocol, direct_vm, direct_charlie, "INC-1", "HALT", at_t0 + HALT_TTL, 90)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.clear_response()
    # The guard is not the owner either.
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.clear_response()
