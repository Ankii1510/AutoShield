"""
Shared fixtures for AutoShield direct-mode tests.

This file also carries four documented workarounds for real limitations in
gltest 0.30.0rc2 direct mode. All four are test-harness concerns only — the
contracts themselves use the production GenLayer APIs unchanged.

  1. `direct_vm.warp()` does not reach `gl.message.raw['datetime']`.
     VMContext._refresh_gl_message() updates only `sender_address` and
     `origin_address`, so the contract clock never moves. The `warp` fixture
     below sets the datetime on the live `gl.message.raw` dict as well.

  2. `Contract.__init_subclass__` records the contract class in a
     module-level global in the SDK, which persists for the lifetime of the
     pytest process. Deploying a *different* contract file in a later test
     raises "only one contract is allowed". The autouse fixture resets it.

  3. Every contract in a direct VM is allocated at the same ROOT_SLOT_ID, so
     two contracts deployed into one VM would share storage. We therefore
     never deploy both contracts into the same VM. Cross-contract behaviour is
     tested through `protocol_bridge`, which answers AutoShield's synchronous
     `CallContract` telemetry read and captures its asynchronous `PostMessage`
     so tests can assert the exact wire arguments. Genuine end-to-end delivery
     belongs in integration tests against GLSim or Studio.

  4. gltest's LLM mock handler pre-parses a JSON-looking mock string into a
     dict before handing it back, which was correct for GenVM v0.5. v0.6's
     `gl.nondet._decode_nondet_json` requires the `ok` payload to be TEXT and
     runs `json.loads` on it itself, so a pre-parsed dict fails with
     "invalid nondeterministic response: JSON result is not text". The autouse
     fixture below hands back the raw mock string instead — which is exactly
     what the real executor returns, so this makes direct mode MORE faithful
     to production rather than less.
"""

import sys
import json
import datetime
from pathlib import Path

import pytest

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
PROTOCOL_CONTRACT = str(CONTRACTS / "demo_lending.py")
AUTOSHIELD_CONTRACT = str(CONTRACTS / "autoshield.py")

# ---------------------------------------------------------------------------
# Canonical test time base
# ---------------------------------------------------------------------------
T0_ISO = "2026-06-01T12:00:00Z"
_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)

ONE_ATTO = 10**18

# Mirrors of the contracts' constants, restated here on purpose: if a constant
# changes in a contract, the test suite should fail loudly rather than follow
# it silently.
MAX_RESPONSE_TTL_SECONDS = 7200
HALT_DECAY_TO_RESTRICTED_SECONDS = 1800
MAX_CONSECUTIVE_HALTS = 3
RESTRICTED_WITHDRAW_CAP_BPS = 2000

FRESHNESS_WINDOW_SECONDS = 600
EVALUATION_WINDOW_SECONDS = 900
EXECUTION_WINDOW_SECONDS = 300
PROTECT_TTL_SECONDS = 3600
HALT_TTL_SECONDS = 1800
REPORT_COOLDOWN_SECONDS = 60
MAX_OPEN_INCIDENTS = 8
MAX_REPORTS_PER_WINDOW = 20

SIGNAL_PRICE_MANIPULATION = 1 << 0
SIGNAL_LIQUIDITY_DRAIN = 1 << 1
SIGNAL_BORROW_ANOMALY = 1 << 2
SIGNAL_COORDINATED_ACTIVITY = 1 << 3
SIGNAL_EVIDENCE_INCONSISTENT = 1 << 4
SIGNAL_CONDITION_RESOLVED = 1 << 5
ALL_SIGNALS_MASK = (1 << 6) - 1

SIGNAL_NAMES = (
    "price_manipulation",
    "liquidity_drain",
    "borrow_anomaly",
    "coordinated_activity",
    "evidence_inconsistent",
    "condition_resolved",
)


def iso_to_ts(value: str) -> int:
    text = value.strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    delta = parsed - _EPOCH
    return delta.days * 86400 + delta.seconds


def ts_to_iso(value: int) -> str:
    return (
        datetime.datetime.fromtimestamp(value, tz=datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


T0_TS = iso_to_ts(T0_ISO)


def addr(value):
    """
    Wrap a direct-mode test address as a genlayer `Address`.

    The `direct_*` fixtures hand back raw 20-byte values. Constructor and
    method arguments are round-tripped through calldata before reaching the
    contract, and raw bytes decode as `bytes` rather than `Address`, which
    then fails when written to an `Address` storage field. Production callers
    encode a real Address, so wrapping here matches production rather than
    papering over a contract bug.
    """
    from genlayer.types import Address

    if isinstance(value, Address):
        return value
    return Address(value)


@pytest.fixture(autouse=True)
def _sdk_env(direct_vm):
    """
    Make `genlayer` importable from test code before any contract is deployed.

    gltest only puts the SDK on `sys.path` inside `load_contract_class`, so a
    fixture that needs to build an `Address` for a constructor argument cannot
    import it yet. This performs exactly the same preparation steps the loader
    performs — wasi mock, SDK paths, message on fd 0 — without loading a
    contract class (which would claim the one-contract-per-process slot).
    """
    from gltest.direct import wasi_mock
    from gltest.direct.sdk_loader import setup_sdk_paths
    from gltest.direct.loader import _inject_message_to_fd0

    wasi_mock.set_vm(direct_vm)
    sys.modules["_genlayer_wasi"] = wasi_mock
    setup_sdk_paths(Path(AUTOSHIELD_CONTRACT), None)
    _inject_message_to_fd0(direct_vm)
    yield


@pytest.fixture(autouse=True)
def _reset_contract_registry():
    """Workaround (2): clear the SDK's one-contract-per-process global."""
    module = sys.modules.get("genlayer.contract")
    if module is not None:
        module.__known_contract__ = None
    yield
    module = sys.modules.get("genlayer.contract")
    if module is not None:
        module.__known_contract__ = None


@pytest.fixture(autouse=True)
def _raw_llm_mock_payload(monkeypatch):
    """Workaround (4): return the mock response as text, as GenVM v0.6 does."""
    from gltest.direct import wasi_mock

    def handle(vm, data):
        response = vm._match_llm_mock(data.get("prompt", ""))
        if response is None:
            # Not a mocked prompt: strict mode, live handlers and the
            # "no mock registered" error all still belong to gltest.
            return _original_handle_llm_request(vm, data)
        return {"ok": response}

    _original_handle_llm_request = wasi_mock._handle_llm_request
    monkeypatch.setattr(wasi_mock, "_handle_llm_request", handle)
    yield


def _apply_datetime(value_iso: str) -> None:
    """Workaround (1): push the datetime into the live `gl.message.raw` dict."""
    message = sys.modules.get("genlayer.message")
    if message is not None and getattr(message, "raw", None) is not None:
        message.raw["datetime"] = value_iso
        # v0.6 also splats `raw` into the module globals at import, so the
        # module-level alias has to move with it or `gl.message.datetime`
        # would keep reporting the deploy-time value.
        setattr(message, "datetime", value_iso)


@pytest.fixture
def warp(direct_vm):
    """
    Move the contract clock. Accepts an ISO string or unix seconds.

    Returns the unix-second value it moved to, so tests can do arithmetic
    without repeating the conversion.
    """

    def _warp(value) -> int:
        value_iso = value if isinstance(value, str) else ts_to_iso(int(value))
        direct_vm.warp(value_iso)
        _apply_datetime(value_iso)
        return iso_to_ts(value_iso)

    direct_vm.warp(T0_ISO)
    _apply_datetime(T0_ISO)
    return _warp


@pytest.fixture
def at_t0(direct_vm, warp):
    """Pin the clock to T0 before deployment and return T0 in unix seconds."""
    warp(T0_ISO)
    return T0_TS


class ProtocolBridge:
    """
    Stands in for DemoLendingProtocol during AutoShield direct tests.

    Answers the synchronous `CallContract` telemetry read and records every
    asynchronous `PostMessage` so a test can assert exactly what AutoShield
    would send across the wire.
    """

    def __init__(self):
        self.telemetry = {
            "price_atto": ONE_ATTO,
            "baseline_atto": ONE_ATTO,
            "deviation_bps": 0,
            "seconds_since_update": 0,
            "total_deposits_atto": 0,
            "total_borrowed_atto": 0,
            "available_liquidity_atto": 0,
            "utilisation_bps": 0,
            "window_volume_bps": 0,
            "liquidity_delta_bps": 0,
            "tx_count": 0,
            "unique_senders": 0,
            "top_sender_share_bps": 0,
            "mode": "NORMAL",
            "now_ts": T0_TS,
        }
        self.messages = []

    # GenVM v0.6 keys the invoked method under the EMPTY string in a calldata
    # object (`genlayer.contract._make_calldata_obj` writes `ret[''] = method`).
    # Reading `"method"` here silently yielded None, which this bridge then
    # reported as an unexpected view — and the resulting error payload failed to
    # decode, hiding the real cause behind a DecodingError.
    METHOD_KEY = ""

    def install(self, vm) -> "ProtocolBridge":
        from genlayer import calldata
        from genlayer.vm.public_abi import ResultCode

        def hook(_vm, request):
            if "CallContract" in request:
                payload = request["CallContract"]
                method = payload["calldata"].get(self.METHOD_KEY)
                if method != "telemetry":
                    # The payload after the result byte is calldata, not raw
                    # UTF-8: `gl.vm._decode_sub_vm_result_retn` runs it through
                    # `calldata.decode` for USER_ERROR exactly as it does for
                    # RETURN.
                    return bytes([ResultCode.USER_ERROR]) + calldata.encode(
                        f"[EXPECTED] Unexpected view {method}"
                    )
                return bytes([ResultCode.RETURN]) + calldata.encode(self.telemetry)

            # GenVM v0.6 renamed the asynchronous cross-contract request from
            # `PostMessage` to `EmitInternalMessage`. The payload fields are
            # unchanged (address / calldata / value / on).
            if "EmitInternalMessage" in request:
                payload = request["EmitInternalMessage"]
                body = payload["calldata"]
                self.messages.append(
                    {
                        "address": payload["address"],
                        "method": body.get(self.METHOD_KEY),
                        "args": list(body.get("args", [])),
                        "on": payload.get("on"),
                        "value": payload.get("value"),
                    }
                )
                return {"ok": None}

            return None

        vm._gl_call_hook = hook
        return self

    @property
    def last_message(self):
        assert self.messages, "no cross-contract message was emitted"
        return self.messages[-1]


@pytest.fixture
def protocol_bridge(direct_vm):
    return ProtocolBridge()


# ---------------------------------------------------------------------------
# Deployment helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def protocol(direct_vm, direct_deploy, direct_owner, at_t0):
    """A freshly deployed DemoLendingProtocol owned by `direct_owner`."""
    direct_vm.sender = direct_owner
    return direct_deploy(PROTOCOL_CONTRACT, ONE_ATTO)


@pytest.fixture
def guarded_protocol(direct_vm, protocol, direct_owner, direct_charlie):
    """DemoLendingProtocol with `direct_charlie` wired as the guard."""
    direct_vm.sender = direct_owner
    protocol.set_initial_guard(addr(direct_charlie))
    return protocol


@pytest.fixture
def funded_protocol(direct_vm, guarded_protocol, direct_owner, direct_alice, direct_bob):
    """Guarded protocol with Alice and Bob each holding 1,000 demo units."""
    direct_vm.sender = direct_owner
    guarded_protocol.mint_demo_balance(addr(direct_alice), 1000 * ONE_ATTO)
    guarded_protocol.mint_demo_balance(addr(direct_bob), 1000 * ONE_ATTO)
    return guarded_protocol


@pytest.fixture
def shield(direct_vm, direct_deploy, direct_owner, direct_bob, direct_alice,
           protocol_bridge, at_t0):
    """
    A freshly deployed AutoShield, with the protocol bridge already installed.

    `direct_bob` holds the evaluator role (who may trigger adjudication) and
    `direct_alice` is an authorised reporter. The bridge is installed by
    default because `adjudicate()` reads the protected protocol's telemetry
    synchronously before entering the nondet block; a test that wants different
    telemetry mutates the same `protocol_bridge` instance.
    """
    protocol_bridge.install(direct_vm)
    from gltest.direct.loader import create_address

    protocol_addr = addr(create_address("protocol-under-protection"))
    direct_vm.sender = direct_owner
    contract = direct_deploy(AUTOSHIELD_CONTRACT, protocol_addr, addr(direct_bob))
    contract.set_reporter(addr(direct_alice), True)
    return contract


def report(shield, direct_vm, reporter, now_ts, *, category="ORACLE_DEVIATION",
           evidence_hash="0x" + "ab" * 32, uri="ipfs://evidence", metadata="{}"):
    """Submit a well-formed incident and return its id."""
    direct_vm.sender = reporter
    return shield.report_incident(category, now_ts, evidence_hash, uri, metadata)


# ---------------------------------------------------------------------------
# Adjudication helpers (Phase 3)
# ---------------------------------------------------------------------------

EVALUATOR_PROMPT_PATTERN = r"(?s).*blockchain security analyst.*"


def verdict_json(severity, bits=0, **overrides):
    """
    Build an evaluator response with the exact seven-key output schema.

    `bits` uses the same bitfield as the contract so existing tests can keep
    expressing signals the way they always did. `overrides` injects raw values
    for malformed-output tests — including extra keys, which the contract must
    ignore structurally.
    """
    payload = {"severity": severity}
    for index, name in enumerate(SIGNAL_NAMES):
        payload[name] = bool((bits >> index) & 1)
    payload.update(overrides)
    return json.dumps(payload)


def mock_evaluator(direct_vm, response):
    """
    Point the evaluator prompt at a canned response.

    Direct mode runs the LEADER ONLY — `gl.vm.run_nondet` is patched to call
    `leader_fn()` and record the validator for later replay. So a test using
    this fixture exercises the leader path and every deterministic step after
    it; it does NOT demonstrate that consensus occurred. Validator behaviour is
    exercised separately via `direct_vm.run_validator(...)` in
    test_adjudication_consensus.py, and true multi-validator consensus is an
    integration-test concern.
    """
    direct_vm.clear_mocks()
    direct_vm.mock_llm(EVALUATOR_PROMPT_PATTERN, response)


def contract_module():
    """
    The loaded AutoShield contract module, for unit-testing its pure functions.

    gltest imports a contract file as `_contract_<stem>`; reaching for it here
    lets `_compare_verdicts`, `_parse_verdict` and `derive_level` be tested
    directly, which matters because direct mode never runs validator code.
    """
    module = sys.modules.get("_contract_autoshield")
    assert module is not None, "deploy the AutoShield contract first"
    return module


def adjudicate_with(shield, direct_vm, evaluator, incident_id, severity, bits=0,
                    **overrides):
    """Mock the evaluator, then run adjudication as the evaluator role."""
    mock_evaluator(direct_vm, verdict_json(severity, bits, **overrides))
    direct_vm.sender = evaluator
    return shield.adjudicate(incident_id)
