"""
What the integration environment actually provides.

These tests are deliberately first: they record, as executable assertions, the
capabilities the rest of the suite is entitled to rely on — and the ones it is
not. If a future toolchain version changes any of this, these fail before the
scenario tests start making claims that are no longer true.
"""

from conftest import (
    LIVE_LLM,
    SIGNAL_PRICE_MANIPULATION,
    adjudicate,
    assert_ok,
    contract_now,
    file_incident,
    votes_of,
)


def test_node_is_a_real_genlayer_sim_network(node):
    assert node["chain_id"] == 61999, (
        "glsim chain id must match genlayer_py.chains.localnet; "
        "start it with scripts/glsim.sh"
    )


def test_contracts_are_separately_deployed_at_real_addresses(fresh):
    """
    Unlike direct mode, these are two distinct contracts with distinct storage.

    Direct mode allocates every contract at the same ROOT_SLOT_ID, so the two
    could not previously coexist in one VM at all.
    """
    protocol_address = fresh["protocol_address"]
    shield_address = fresh["shield_address"]

    assert protocol_address and shield_address
    assert protocol_address != shield_address

    status = fresh["protocol"].get_status(args=[]).call()
    config = fresh["shield"].get_config(args=[]).call()

    assert status["mode"] == "NORMAL"
    assert config["protocol_address"].lower() == protocol_address.lower()
    assert config["evaluator"].lower() == fresh["evaluator"].address.lower()
    assert status["guard_address"].lower() == shield_address.lower()


def test_cross_contract_view_reaches_the_real_protocol(fresh):
    """
    AutoShield's synchronous telemetry read crosses a real contract boundary.

    In direct mode this had to be answered by a stand-in bridge.
    """
    telemetry = fresh["shield"].protocol_telemetry(args=[]).call()
    assert telemetry["mode"] == "NORMAL"
    assert telemetry["deviation_bps"] == 0

    owner_protocol = fresh["protocol"].connect(fresh["owner"])
    assert_ok(owner_protocol.simulate_oracle_move(args=[4100, "DOWN"]).transact(),
              "simulate_oracle_move")

    telemetry = fresh["shield"].protocol_telemetry(args=[]).call()
    assert telemetry["deviation_bps"] == 4100, (
        "AutoShield must observe the protocol's live telemetry, not a cached copy"
    )


def test_every_transaction_is_voted_on_by_multiple_validators(fresh, sim):
    """
    Consensus voting really happens: five validators, one vote each.

    Each validator runs the contract's own `validator_fn`; the node tallies a
    majority and rotates the leader on disagreement.
    """
    incident_id, _ = file_incident(fresh)
    receipt = adjudicate(fresh, sim, incident_id, 90, SIGNAL_PRICE_MANIPULATION)
    assert_ok(receipt, "adjudicate")

    votes = votes_of(receipt)
    assert len(votes) == 5, f"expected 5 validators, got {len(votes)}: {votes}"
    assert set(votes.values()) == {"agree"}

    validators = receipt["consensus_data"]["validators"]
    assert len(validators) == 5
    assert all(v["execution_result"] == "SUCCESS" for v in validators)


def test_time_control_availability_is_recorded(fresh, sim):
    """
    Record whether the node's clock control reaches the contract clock.

    GLSim exposes `sim_increaseTime`, but it moves time by calling
    `VMContext.warp()`, and gltest 0.29.2's `warp` does not write
    `gl.message_raw['datetime']` — the only clock a GenLayer contract can read.
    This test measures the truth rather than assuming it, and the expiry
    scenarios consult the same measurement.
    """
    before = contract_now(fresh)
    sim.increase_time(10_000)
    after = contract_now(fresh)

    delta = after - before
    print(f"\n[env] contract clock moved {delta}s for a 10000s node increase")

    # Either it works, or it does not; both are acceptable, but the suite must
    # know which. A partial or erratic move would be a genuine problem.
    assert delta == 0 or delta >= 9_000, (
        f"unexpected partial clock movement: {delta}s"
    )


def test_live_llm_mode_is_off_by_default(node):
    """
    Records which evaluator backend produced these results.

    With mocks, every validator necessarily sees the same answer, so agreement
    is guaranteed by construction and proves execution rather than convergence.
    """
    print(f"\n[env] live LLM provider: {node['live_llm']}")
    assert node["live_llm"] is LIVE_LLM
