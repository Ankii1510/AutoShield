"""
The seam between AutoShield and DemoLendingProtocol.

Direct mode allocates every contract at the same storage root, so the two
contracts cannot be deployed into one VM. This file closes that gap without
pretending otherwise: one test captures the exact message AutoShield would
send, another feeds those captured arguments into the real protocol. If the
two sides ever disagree about argument order, types or bounds, one of these
fails.

True delivery across the consensus boundary — the asynchronous `emit` hop —
is an integration-test concern and is covered in tests/integration/.
"""

from conftest import (
    adjudicate_with,
    HALT_TTL_SECONDS,
    PROTECT_TTL_SECONDS,
    SIGNAL_LIQUIDITY_DRAIN,
    SIGNAL_PRICE_MANIPULATION,
    report,
)


def _captured_message(direct_vm, shield, bridge, evaluator, reporter, now_ts,
                      severity, signals):
    bridge.install(direct_vm)
    incident_id = report(shield, direct_vm, reporter, now_ts)
    adjudicate_with(shield, direct_vm, evaluator, incident_id, severity, signals)
    direct_vm.sender = reporter
    shield.execute_response(incident_id)
    return bridge.last_message


def test_halt_message_is_accepted_verbatim_by_the_protocol(
    direct_vm, shield, protocol_bridge, direct_bob, direct_alice, at_t0
):
    """Capture what AutoShield sends for a HALT verdict."""
    message = _captured_message(
        direct_vm, shield, protocol_bridge, direct_bob, direct_alice,
        at_t0, 95, SIGNAL_PRICE_MANIPULATION,
    )
    incident_id, level, deadline_ts, severity = message["args"]

    assert message["method"] == "apply_response"
    assert level == "HALT"
    assert deadline_ts == at_t0 + HALT_TTL_SECONDS
    assert severity == 95
    assert isinstance(incident_id, str) and incident_id.startswith("INC-")


def test_protocol_accepts_the_captured_halt_arguments(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    """
    The other half: the protocol accepts exactly those arguments.

    Values are the ones the previous test observed on the wire.
    """
    direct_vm.sender = direct_charlie
    applied = guarded_protocol.apply_response(
        "INC-1", "HALT", at_t0 + HALT_TTL_SECONDS, 95
    )
    assert applied == "HALT"

    status = guarded_protocol.get_status()
    assert status["mode"] == "HALTED"
    assert status["active_incident_id"] == "INC-1"
    assert status["mode_deadline_ts"] == at_t0 + HALT_TTL_SECONDS


def test_protect_message_is_accepted_verbatim_by_the_protocol(
    direct_vm, shield, protocol_bridge, direct_bob, direct_alice, at_t0
):
    message = _captured_message(
        direct_vm, shield, protocol_bridge, direct_bob, direct_alice,
        at_t0, 55, SIGNAL_LIQUIDITY_DRAIN,
    )
    _, level, deadline_ts, severity = message["args"]
    assert level == "PROTECT"
    assert deadline_ts == at_t0 + PROTECT_TTL_SECONDS
    assert severity == 55


def test_protocol_accepts_the_captured_protect_arguments(
    direct_vm, guarded_protocol, direct_charlie, at_t0
):
    direct_vm.sender = direct_charlie
    applied = guarded_protocol.apply_response(
        "INC-1", "PROTECT", at_t0 + PROTECT_TTL_SECONDS, 55
    )
    assert applied == "PROTECT"
    assert guarded_protocol.get_mode() == "RESTRICTED"


def test_autoshield_never_requests_a_deadline_the_protocol_would_reject(
    direct_vm, shield, protocol_bridge, direct_bob, direct_alice, at_t0
):
    """
    Both TTLs AutoShield can ask for sit inside the protocol's ceiling, so the
    clamp is a defence against a compromised guard rather than a routine path.
    """
    from conftest import MAX_RESPONSE_TTL_SECONDS

    assert HALT_TTL_SECONDS < MAX_RESPONSE_TTL_SECONDS
    assert PROTECT_TTL_SECONDS < MAX_RESPONSE_TTL_SECONDS

    message = _captured_message(
        direct_vm, shield, protocol_bridge, direct_bob, direct_alice,
        at_t0, 95, SIGNAL_PRICE_MANIPULATION,
    )
    _, _, deadline_ts, _ = message["args"]
    assert at_t0 < deadline_ts <= at_t0 + MAX_RESPONSE_TTL_SECONDS
