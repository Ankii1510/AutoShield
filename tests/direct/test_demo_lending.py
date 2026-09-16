"""
DemoLendingProtocol — core market behaviour under NORMAL mode.

Emergency-response behaviour lives in test_response_modes.py; authority and
attack-resistance in test_protocol_security.py.
"""

import pytest

from conftest import ONE_ATTO, addr


def test_initial_state(protocol, at_t0):
    status = protocol.get_status()
    assert status["mode"] == "NORMAL"
    assert status["active_incident_id"] == ""
    assert status["consecutive_halts"] == 0
    assert status["borrow_enabled"] is True
    assert status["repay_enabled"] is True

    telemetry = protocol.telemetry()
    assert telemetry["deviation_bps"] == 0
    assert telemetry["utilisation_bps"] == 0
    assert telemetry["now_ts"] == at_t0


def test_conservation_holds_on_a_fresh_protocol(protocol):
    assert protocol.conservation_check()["balanced"] is True


# ---------------------------------------------------------------------------
# Deposits and withdrawals
# ---------------------------------------------------------------------------


def test_deposit_moves_wallet_into_position(direct_vm, funded_protocol, direct_alice):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(500 * ONE_ATTO)

    position = funded_protocol.get_position(addr(direct_alice))
    assert position["deposited_atto"] == 500 * ONE_ATTO
    assert position["wallet_atto"] == 500 * ONE_ATTO
    assert funded_protocol.telemetry()["total_deposits_atto"] == 500 * ONE_ATTO
    assert funded_protocol.conservation_check()["balanced"] is True


def test_withdraw_returns_units_to_the_wallet(direct_vm, funded_protocol, direct_alice):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(500 * ONE_ATTO)
    funded_protocol.withdraw(200 * ONE_ATTO)

    position = funded_protocol.get_position(addr(direct_alice))
    assert position["deposited_atto"] == 300 * ONE_ATTO
    assert position["wallet_atto"] == 700 * ONE_ATTO
    assert funded_protocol.conservation_check()["balanced"] is True


def test_deposit_beyond_wallet_balance_is_rejected(
    direct_vm, funded_protocol, direct_alice
):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Insufficient wallet balance"):
        funded_protocol.deposit(5000 * ONE_ATTO)


def test_withdraw_beyond_deposit_is_rejected(direct_vm, funded_protocol, direct_alice):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(100 * ONE_ATTO)
    with direct_vm.expect_revert("Insufficient deposit"):
        funded_protocol.withdraw(200 * ONE_ATTO)


@pytest.mark.parametrize("method", ["deposit", "withdraw", "borrow", "repay"])
def test_zero_and_negative_amounts_are_rejected(
    direct_vm, funded_protocol, direct_alice, method
):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Amount must be positive"):
        getattr(funded_protocol, method)(0)


# ---------------------------------------------------------------------------
# Borrowing
# ---------------------------------------------------------------------------


def test_borrow_within_collateral_capacity(direct_vm, funded_protocol, direct_alice):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)

    # 400 units of collateral at price 1.0 with a 75% LTV ceiling.
    assert funded_protocol.get_position(addr(direct_alice))["borrow_capacity_atto"] == (
        300 * ONE_ATTO
    )

    funded_protocol.borrow(300 * ONE_ATTO)
    position = funded_protocol.get_position(addr(direct_alice))
    assert position["debt_atto"] == 300 * ONE_ATTO
    assert position["wallet_atto"] == 900 * ONE_ATTO
    assert funded_protocol.conservation_check()["balanced"] is True


def test_borrow_beyond_capacity_is_rejected(direct_vm, funded_protocol, direct_alice):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    with direct_vm.expect_revert("Exceeds collateral capacity"):
        funded_protocol.borrow(301 * ONE_ATTO)


def test_borrow_beyond_available_liquidity_is_rejected(
    direct_vm, funded_protocol, direct_alice, direct_bob, direct_owner
):
    """
    Liquidity, not collateral, is the binding constraint here.

    At a price of 1.0 a position can never out-borrow the pool it deposited
    into, so this needs a higher oracle price to lift collateral capacity above
    the liquidity actually available.
    """
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    direct_vm.sender = direct_bob
    funded_protocol.deposit(400 * ONE_ATTO)
    funded_protocol.borrow(300 * ONE_ATTO)  # pool: 800 deposited, 300 borrowed

    direct_vm.sender = direct_owner
    funded_protocol.set_oracle_price(4 * ONE_ATTO)

    direct_vm.sender = direct_alice
    # Capacity is now 400 * 4 * 0.75 = 1200, but only 500 is available.
    assert funded_protocol.get_position(addr(direct_alice))["borrow_capacity_atto"] == (
        1200 * ONE_ATTO
    )
    with direct_vm.expect_revert("Insufficient protocol liquidity"):
        funded_protocol.borrow(501 * ONE_ATTO)


def test_withdraw_that_would_break_collateral_ratio_is_rejected(
    direct_vm, funded_protocol, direct_alice
):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    funded_protocol.borrow(300 * ONE_ATTO)
    with direct_vm.expect_revert("Withdrawal breaks collateral ratio"):
        funded_protocol.withdraw(1 * ONE_ATTO)


# ---------------------------------------------------------------------------
# Repayment
# ---------------------------------------------------------------------------


def test_repay_reduces_debt_in_normal_mode(direct_vm, funded_protocol, direct_alice):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    funded_protocol.borrow(300 * ONE_ATTO)
    funded_protocol.repay(120 * ONE_ATTO)

    position = funded_protocol.get_position(addr(direct_alice))
    assert position["debt_atto"] == 180 * ONE_ATTO
    assert funded_protocol.telemetry()["total_borrowed_atto"] == 180 * ONE_ATTO
    assert funded_protocol.conservation_check()["balanced"] is True


def test_repay_beyond_debt_is_rejected(direct_vm, funded_protocol, direct_alice):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    funded_protocol.borrow(100 * ONE_ATTO)
    with direct_vm.expect_revert("Repayment exceeds debt"):
        funded_protocol.repay(101 * ONE_ATTO)


def test_full_repayment_frees_collateral(direct_vm, funded_protocol, direct_alice):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    funded_protocol.borrow(300 * ONE_ATTO)
    funded_protocol.repay(300 * ONE_ATTO)
    funded_protocol.withdraw(400 * ONE_ATTO)

    position = funded_protocol.get_position(addr(direct_alice))
    assert position["debt_atto"] == 0
    assert position["deposited_atto"] == 0
    assert position["wallet_atto"] == 1000 * ONE_ATTO
    assert funded_protocol.conservation_check()["balanced"] is True


# ---------------------------------------------------------------------------
# Oracle and telemetry
# ---------------------------------------------------------------------------


def test_utilisation_is_reported_in_basis_points(
    direct_vm, funded_protocol, direct_alice
):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    funded_protocol.borrow(200 * ONE_ATTO)
    assert funded_protocol.telemetry()["utilisation_bps"] == 5000


def test_oracle_price_change_moves_borrow_capacity(
    direct_vm, funded_protocol, direct_alice, direct_owner
):
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)

    direct_vm.sender = direct_owner
    funded_protocol.set_oracle_price(2 * ONE_ATTO)

    assert funded_protocol.get_position(addr(direct_alice))["borrow_capacity_atto"] == (
        600 * ONE_ATTO
    )


# ---------------------------------------------------------------------------
# Demo simulation surface
# ---------------------------------------------------------------------------


def test_simulate_oracle_move_reports_deviation(
    direct_vm, funded_protocol, direct_owner
):
    direct_vm.sender = direct_owner
    funded_protocol.simulate_oracle_move(4100, "DOWN")

    telemetry = funded_protocol.telemetry()
    assert telemetry["deviation_bps"] == 4100
    assert telemetry["price_atto"] == 59 * ONE_ATTO // 100


def test_simulate_oracle_move_rejects_bad_direction(
    direct_vm, funded_protocol, direct_owner
):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("Direction must be UP or DOWN"):
        funded_protocol.simulate_oracle_move(1000, "SIDEWAYS")


def test_simulations_surface_in_telemetry(direct_vm, funded_protocol, direct_owner):
    direct_vm.sender = direct_owner
    funded_protocol.simulate_borrow_spike(6200)
    funded_protocol.simulate_liquidity_drain(4500)
    funded_protocol.simulate_tx_burst(320, 4, 8800)

    telemetry = funded_protocol.telemetry()
    assert telemetry["window_volume_bps"] == 6200
    assert telemetry["liquidity_delta_bps"] == 4500
    assert telemetry["tx_count"] == 320
    assert telemetry["unique_senders"] == 4
    assert telemetry["top_sender_share_bps"] == 8800


def test_simulation_never_corrupts_real_accounting(
    direct_vm, funded_protocol, direct_alice, direct_owner
):
    """
    The simulation surface is a telemetry overlay, not a balance mutation.

    This is what keeps the demo honest: the "attack" changes what the protocol
    *reports*, never who owns what.
    """
    direct_vm.sender = direct_alice
    funded_protocol.deposit(400 * ONE_ATTO)
    funded_protocol.borrow(200 * ONE_ATTO)
    before = funded_protocol.get_position(addr(direct_alice))

    direct_vm.sender = direct_owner
    funded_protocol.simulate_oracle_move(4100, "DOWN")
    funded_protocol.simulate_borrow_spike(9000)
    funded_protocol.simulate_liquidity_drain(7000)
    funded_protocol.simulate_tx_burst(500, 2, 9500)

    after = funded_protocol.get_position(addr(direct_alice))
    assert after["deposited_atto"] == before["deposited_atto"]
    assert after["debt_atto"] == before["debt_atto"]
    assert after["wallet_atto"] == before["wallet_atto"]
    assert funded_protocol.conservation_check()["balanced"] is True


def test_reset_simulation_restores_baseline(direct_vm, funded_protocol, direct_owner):
    direct_vm.sender = direct_owner
    funded_protocol.simulate_oracle_move(3000, "UP")
    funded_protocol.simulate_borrow_spike(5000)
    funded_protocol.reset_simulation()

    telemetry = funded_protocol.telemetry()
    assert telemetry["deviation_bps"] == 0
    assert telemetry["window_volume_bps"] == 0
