"""
Authority boundaries on DemoLendingProtocol.

The claim under test: AutoShield (the guard) can only ever *narrow* what users
may do, for a bounded time, and cannot touch value, ownership, the oracle, or
the simulation surface.
"""

import pytest

from conftest import ONE_ATTO, addr

HALT_TTL = 1800
GUARD_ROTATION_DELAY_SECONDS = 86400


# ---------------------------------------------------------------------------
# Guard authorization
# ---------------------------------------------------------------------------


def test_apply_response_requires_the_guard(
    direct_vm, guarded_protocol, direct_alice, direct_owner, at_t0
):
    """Not the owner, not a user — only the wired guard address."""
    for impostor in (direct_alice, direct_owner):
        direct_vm.sender = impostor
        with direct_vm.expect_revert("Only guard"):
            guarded_protocol.apply_response("INC-1", "HALT", at_t0 + HALT_TTL, 90)


def test_apply_response_fails_before_a_guard_is_wired(
    direct_vm, protocol, direct_alice, at_t0
):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Guard not set"):
        protocol.apply_response("INC-1", "HALT", at_t0 + HALT_TTL, 90)


def test_initial_guard_is_one_shot(
    direct_vm, guarded_protocol, direct_owner, direct_alice
):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("Guard already initialized"):
        guarded_protocol.set_initial_guard(addr(direct_alice))


def test_only_owner_can_wire_the_initial_guard(direct_vm, protocol, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Only owner"):
        protocol.set_initial_guard(addr(direct_alice))


def test_guard_cannot_be_the_zero_address(direct_vm, protocol, direct_owner):
    from genlayer.types import Address

    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("Guard cannot be zero address"):
        protocol.set_initial_guard(Address(bytes(20)))


# ---------------------------------------------------------------------------
# Guard rotation is timelocked
# ---------------------------------------------------------------------------


def test_guard_rotation_requires_the_timelock_to_elapse(
    direct_vm, guarded_protocol, direct_owner, direct_alice, at_t0, warp
):
    direct_vm.sender = direct_owner
    guarded_protocol.propose_guard(addr(direct_alice))

    with direct_vm.expect_revert("Guard timelock not elapsed"):
        guarded_protocol.accept_guard()

    warp(at_t0 + GUARD_ROTATION_DELAY_SECONDS - 1)
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("Guard timelock not elapsed"):
        guarded_protocol.accept_guard()

    warp(at_t0 + GUARD_ROTATION_DELAY_SECONDS)
    direct_vm.sender = direct_owner
    guarded_protocol.accept_guard()
    assert guarded_protocol.get_status()["guard_address"] == addr(direct_alice).as_hex


def test_guard_rotation_is_owner_only(
    direct_vm, guarded_protocol, direct_alice, direct_charlie
):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.propose_guard(addr(direct_alice))

    # The sitting guard cannot rotate itself either.
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.propose_guard(addr(direct_charlie))


def test_accept_guard_without_a_proposal_is_rejected(
    direct_vm, guarded_protocol, direct_owner
):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("No pending guard"):
        guarded_protocol.accept_guard()


# ---------------------------------------------------------------------------
# Replay protection
# ---------------------------------------------------------------------------


def test_an_incident_id_can_only_be_applied_once(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    direct_vm.sender = direct_charlie
    guarded_protocol.apply_response("INC-1", "HALT", at_t0 + HALT_TTL, 90)

    with direct_vm.expect_revert("Incident already applied"):
        guarded_protocol.apply_response("INC-1", "HALT", at_t0 + HALT_TTL, 90)


def test_replay_is_rejected_even_after_the_response_lapsed(
    direct_vm, guarded_protocol, direct_charlie, at_t0, warp
):
    """
    The replay record outlives the response.

    Otherwise a captured message could be re-delivered later to re-halt the
    protocol with evidence that is long out of date.
    """
    direct_vm.sender = direct_charlie
    guarded_protocol.apply_response("INC-1", "HALT", at_t0 + HALT_TTL, 90)

    later = warp(at_t0 + 100000)
    assert guarded_protocol.get_mode() == "NORMAL"

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Incident already applied"):
        guarded_protocol.apply_response("INC-1", "HALT", later + HALT_TTL, 90)


def test_replay_record_is_queryable(direct_vm, guarded_protocol, direct_charlie, at_t0):
    assert guarded_protocol.was_incident_applied("INC-1") is False
    direct_vm.sender = direct_charlie
    guarded_protocol.apply_response("INC-1", "PROTECT", at_t0 + 600, 50)
    assert guarded_protocol.was_incident_applied("INC-1") is True


# ---------------------------------------------------------------------------
# The guard has no other powers
# ---------------------------------------------------------------------------


def test_guard_cannot_move_user_funds(
    direct_vm, funded_protocol, direct_charlie, direct_alice
):
    """
    The guard has no method that credits or debits anyone.

    `mint_demo_balance` is the only way units enter the system, and it is
    owner-only; every other balance change is initiated by the account that
    owns the position.
    """
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    before = funded_protocol.get_position(addr(direct_alice))

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Only owner"):
        funded_protocol.mint_demo_balance(addr(direct_charlie), 1000 * ONE_ATTO)

    # The guard acting as itself moves only its own (empty) position.
    with direct_vm.expect_revert("Insufficient wallet balance"):
        funded_protocol.deposit(1 * ONE_ATTO)
    with direct_vm.expect_revert("Insufficient deposit"):
        funded_protocol.withdraw(1 * ONE_ATTO)

    after = funded_protocol.get_position(addr(direct_alice))
    assert after == before
    assert funded_protocol.conservation_check()["balanced"] is True


def test_guard_cannot_change_the_oracle(direct_vm, guarded_protocol, direct_charlie):
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.set_oracle_price(99 * ONE_ATTO)
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.set_baseline_price(99 * ONE_ATTO)


def test_guard_cannot_drive_the_simulation_surface(
    direct_vm, guarded_protocol, direct_charlie
):
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.simulate_oracle_move(5000, "DOWN")
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.simulate_borrow_spike(9000)
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.simulate_liquidity_drain(9000)
    with direct_vm.expect_revert("Only owner"):
        guarded_protocol.simulate_tx_burst(100, 2, 9000)


def test_applying_a_response_never_changes_balances(
    direct_vm, funded_protocol, direct_charlie, direct_alice, at_t0
):
    """
    The central safety property, asserted end to end: a maximal response
    leaves every balance and every protocol aggregate exactly as it was.
    """
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    funded_protocol.borrow(300 * ONE_ATTO)

    position_before = funded_protocol.get_position(addr(direct_alice))
    telemetry_before = funded_protocol.telemetry()

    direct_vm.sender = direct_charlie
    funded_protocol.apply_response("INC-1", "HALT", at_t0 + HALT_TTL, 100)

    position_after = funded_protocol.get_position(addr(direct_alice))
    telemetry_after = funded_protocol.telemetry()

    assert position_after == position_before
    for key in (
        "total_deposits_atto",
        "total_borrowed_atto",
        "available_liquidity_atto",
        "price_atto",
        "baseline_atto",
    ):
        assert telemetry_after[key] == telemetry_before[key], key
    assert funded_protocol.conservation_check()["balanced"] is True


def test_owner_only_surface_is_closed_to_ordinary_users(
    direct_vm, guarded_protocol, direct_alice
):
    direct_vm.sender = direct_alice
    for call in (
        lambda: guarded_protocol.mint_demo_balance(addr(direct_alice), ONE_ATTO),
        lambda: guarded_protocol.set_oracle_price(2 * ONE_ATTO),
        lambda: guarded_protocol.set_baseline_price(2 * ONE_ATTO),
        lambda: guarded_protocol.clear_response(),
        lambda: guarded_protocol.reset_simulation(),
        lambda: guarded_protocol.propose_guard(addr(direct_alice)),
    ):
        with direct_vm.expect_revert("Only owner"):
            call()


# ---------------------------------------------------------------------------
# Input validation on the simulation surface
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("magnitude", [0, 10000, 20000])
def test_simulate_oracle_move_rejects_out_of_range_magnitudes(
    direct_vm, guarded_protocol, direct_owner, magnitude
):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("Magnitude out of range"):
        guarded_protocol.simulate_oracle_move(magnitude, "DOWN")


def test_simulate_liquidity_drain_rejects_out_of_range(
    direct_vm, guarded_protocol, direct_owner
):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("Drain out of range"):
        guarded_protocol.simulate_liquidity_drain(10001)


def test_deploy_rejects_a_non_positive_price(direct_vm, direct_deploy, direct_owner, at_t0):
    from conftest import PROTOCOL_CONTRACT

    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("Price must be positive"):
        direct_deploy(PROTOCOL_CONTRACT, 0)
