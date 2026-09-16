"""
Integration-test harness: AutoShield against a real GenLayer Sim node.

WHAT THIS ENVIRONMENT IS. GLSim (shipped with `genlayer-test[sim]==0.29.2`) is a
local GenLayer network: transactions are submitted over JSON-RPC, a leader
executes the contract, N validators independently run the contract's own
`validator_fn` against the leader's result, votes are tallied by majority, and
the leader rotates on disagreement. Contracts are deployed at real addresses
with separate storage, and cross-contract `emit` messages are really delivered.

That makes these tests categorically stronger than direct mode, which runs the
leader only and allocates every contract at the same storage root.

WHAT IT STILL IS NOT. See docs/ARCHITECTURE.md, "Consensus Verification".
Without a live LLM provider, every validator receives the same canned evaluator
response through the supported `sim_installMocks` RPC, so they necessarily
agree. Real answer-to-answer variance between validators requires a live
provider (see `AUTOSHIELD_LLM_PROVIDER` below) or a testnet.

RUNNING
    scripts/glsim.sh start 5
    .venv/bin/gltest tests/integration -v -s --network localnet
    scripts/glsim.sh stop

Tests skip with an explicit message if no node is reachable — they never
silently pass.

OPTIONAL LIVE LLM (no secrets in source; environment variables only)
    export AUTOSHIELD_LLM_PROVIDER=openai:gpt-4o-mini
    export OPENAI_API_KEY=...          # or ANTHROPIC_API_KEY for anthropic:*
    scripts/glsim.sh start 5
Then the evaluator is a real model and each validator calls it independently.

TOOLING QUIRKS WORKED AROUND HERE (all reproduced against glsim 0.29.2; the
contracts are unmodified):

  1. Contract source must be pure ASCII. `genlayer_py` hex-encodes it with
     `eth_utils.encode_hex`, which does `value.encode("ascii")`, so a single
     em dash in a docstring breaks schema retrieval.

  2. Address arguments die at glsim's decode -> re-encode boundary
     ("not calldata encodable addr#...: CalldataAddress"). `scripts/glsim_node.py`
     installs a value-preserving shim inside the node process.

  3. `gen_getContractSchemaForCode` and deployment share one class cache keyed
     by code hash, and poison each other: fetching a schema first breaks the
     next deploy ("no attribute '__type_desc__'"), deploying first empties the
     schema. We therefore take the ABI from `genvm-lint schema --json`, which is
     the same toolchain's own schema extractor, and never ask the node for it.

  4. glsim's chain id must match `genlayer_py.chains.localnet` (61999); the
     script sets it.
"""

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"
RPC_URL = os.environ.get("GLSIM_RPC", "http://127.0.0.1:4000/api")

ONE_ATTO = 10**18

SIGNAL_NAMES = (
    "price_manipulation",
    "liquidity_drain",
    "borrow_anomaly",
    "coordinated_activity",
    "evidence_inconsistent",
    "condition_resolved",
)

SIGNAL_PRICE_MANIPULATION = 1 << 0
SIGNAL_LIQUIDITY_DRAIN = 1 << 1
SIGNAL_BORROW_ANOMALY = 1 << 2
SIGNAL_COORDINATED_ACTIVITY = 1 << 3
SIGNAL_EVIDENCE_INCONSISTENT = 1 << 4
SIGNAL_CONDITION_RESOLVED = 1 << 5

# The evaluator prompt's opening line, used as the LLM mock pattern.
EVALUATOR_PATTERN = "blockchain security analyst"

LIVE_LLM = bool(os.environ.get("AUTOSHIELD_LLM_PROVIDER"))


def verdict_json(severity, bits=0, **overrides):
    """An evaluator response in the contract's exact seven-key output schema."""
    payload = {"severity": severity}
    for index, name in enumerate(SIGNAL_NAMES):
        payload[name] = bool((bits >> index) & 1)
    payload.update(overrides)
    return json.dumps(payload)


# ---------------------------------------------------------------------------
# Node connection
# ---------------------------------------------------------------------------


def _rpc(method, params=None, timeout=120):
    import httpx

    response = httpx.post(
        RPC_URL,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []},
        timeout=timeout,
    )
    body = response.json()
    if "error" in body:
        raise RuntimeError(f"{method} failed: {body['error']}")
    return body.get("result")


@pytest.fixture(scope="session")
def node():
    """A reachable GLSim node, or a clear skip."""
    try:
        chain_id = _rpc("eth_chainId", timeout=5)
    except Exception as exc:
        pytest.skip(
            "No GenLayer Sim node reachable at "
            f"{RPC_URL} ({type(exc).__name__}). Start one with:\n"
            "    scripts/glsim.sh start 5\n"
            "Integration tests are never run against mocks."
        )
    return {"chain_id": int(chain_id, 16), "rpc": RPC_URL, "live_llm": LIVE_LLM}


class Sim:
    """Thin wrapper over the node's `sim_*` control RPCs."""

    @staticmethod
    def install_evaluator(response: str):
        return _rpc("sim_installMocks", {"llm_mocks": {EVALUATOR_PATTERN: response}})

    @staticmethod
    def clear_mocks():
        return _rpc("sim_installMocks", {"llm_mocks": {}, "web_mocks": {}})

    @staticmethod
    def now_iso():
        return _rpc("sim_getTime")["effective_datetime"]

    @staticmethod
    def increase_time(seconds: int):
        return _rpc("sim_increaseTime", [int(seconds)])

    @staticmethod
    def snapshot():
        return _rpc("sim_createSnapshot")

    @staticmethod
    def restore(snapshot_id):
        return _rpc("sim_restoreSnapshot", [snapshot_id])


@pytest.fixture(scope="session")
def sim(node):
    return Sim()


# ---------------------------------------------------------------------------
# Schemas, taken from the linter rather than from the node (quirk 3)
# ---------------------------------------------------------------------------


def _schema_for(name: str) -> dict:
    binary = ROOT / ".venv" / "bin" / "genvm-lint"
    result = subprocess.run(
        [str(binary), "schema", str(CONTRACTS / f"{name}.py"), "--json"],
        capture_output=True, text=True, cwd=ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"genvm-lint schema failed for {name}: {result.stderr}")
    return json.loads(result.stdout)["schema"]


@pytest.fixture(scope="session")
def schemas(node):
    return {
        "DemoLendingProtocol": _schema_for("demo_lending"),
        "AutoShield": _schema_for("autoshield"),
    }


# ---------------------------------------------------------------------------
# Deployment
# ---------------------------------------------------------------------------


def leader_receipt(receipt):
    return receipt["consensus_data"]["leader_receipt"][0]


# The execution results that mean "the contract ran and returned". Consensus
# v0.6 renamed this: v0.5 reported "SUCCESS", v0.6 reports
# "FINISHED_WITH_RETURN". Both are listed because glsim 0.30.0rc2 still emits
# the old name while Studio Next emits the new one. Nothing else counts — v0.6
# also defines FINISHED_WITH_ERROR, TIMEOUT, NONDET_DISAGREE and
# DETERMINISTIC_VIOLATION, and every one of those is a failed adjudication.
SUCCESS_RESULTS = ("SUCCESS", "FINISHED_WITH_RETURN")

# Settled lifecycle states. A transaction reaching one of these says the
# network agreed on an outcome, NOT that the contract succeeded — that is what
# SUCCESS_RESULTS is for, and the two are asserted separately on purpose.
SETTLED_STATUSES = ("ACCEPTED", "FINALIZED")


def execution_result(receipt):
    return leader_receipt(receipt)["execution_result"]


def status_name_of(receipt):
    """
    The transaction's lifecycle status as a name.

    Nodes and client versions disagree about how they report it:
    glsim 0.29.2 carried a separate `status_name`; the raw JSON-RPC receipt
    puts the name in `status`; some paths report `status` as the numeric enum;
    and `genlayer-py 0.19.0rc2` replaced the field entirely with a lowercase
    `lifecycle.state`. Reading one spelling and trusting it is how a perfectly
    good transaction gets read as a failure, so all four are handled.
    """
    name = receipt.get("status_name")
    if isinstance(name, str) and name:
        return name
    lifecycle = receipt.get("lifecycle")
    if isinstance(lifecycle, dict):
        state = lifecycle.get("state")
        if isinstance(state, str) and state:
            return state.upper()
    status = receipt.get("status")
    if isinstance(status, str) and status:
        return status
    if isinstance(status, int):
        from genlayer_py.types.transactions import (
            PROTOCOL_TRANSACTION_STATUS_NUMBER_TO_NAME as BY_NUMBER,
        )

        mapped = BY_NUMBER.get(str(status))
        # The enum's *value* is title-cased ("Finalized"); the name is the
        # uppercase form the receipts and these tests use.
        return mapped.name if mapped is not None else str(status)
    return None


def stderr_of(receipt):
    return leader_receipt(receipt)["genvm_result"]["stderr"]


def votes_of(receipt):
    return receipt["consensus_data"]["votes"]


def assert_ok(receipt, what):
    """
    Assert real execution success, not merely a lifecycle status.

    ACCEPTED/FINALIZED say the network settled the transaction; a contract can
    still have errored, in which case no state changed at all.
    """
    assert execution_result(receipt) in SUCCESS_RESULTS, (
        f"{what} failed: {stderr_of(receipt)[:500]}"
    )


@pytest.fixture(scope="session")
def deployment(node, schemas):
    """
    Both contracts deployed once, wired together.

    Session-scoped because glsim reuses one Python process: redeploying the
    same contract code into it trips the SDK's one-contract-per-process
    registry. Per-test isolation comes from `fresh` (snapshot/restore).
    """
    from genlayer_py.types import CalldataAddress as CA
    from gltest import get_accounts, get_contract_factory
    from gltest.contracts.contract import Contract
    from gltest.utils import extract_contract_address

    accounts = get_accounts()
    owner, evaluator, reporter = accounts[0], accounts[1], accounts[2]

    protocol_receipt = get_contract_factory("DemoLendingProtocol").deploy_contract_tx(
        args=[ONE_ATTO]
    )
    assert_ok(protocol_receipt, "DemoLendingProtocol deploy")
    protocol_address = extract_contract_address(protocol_receipt)
    assert protocol_address, "no contract address in deploy receipt"
    protocol = Contract.new(
        address=protocol_address,
        schema=schemas["DemoLendingProtocol"],
        account=owner,
    )

    shield_receipt = get_contract_factory("AutoShield").deploy_contract_tx(
        args=[CA(protocol_address), CA(evaluator.address)]
    )
    assert_ok(shield_receipt, "AutoShield deploy")
    shield_address = extract_contract_address(shield_receipt)
    assert shield_address, "no contract address in deploy receipt"
    shield = Contract.new(
        address=shield_address, schema=schemas["AutoShield"], account=owner
    )

    assert_ok(
        protocol.set_initial_guard(args=[CA(shield_address)]).transact(), "set_guard"
    )
    assert_ok(
        shield.set_reporter(args=[CA(reporter.address), True]).transact(),
        "set_reporter",
    )

    return {
        "protocol": protocol,
        "shield": shield,
        "protocol_address": protocol_address,
        "shield_address": shield_address,
        "owner": owner,
        "evaluator": evaluator,
        "reporter": reporter,
        "accounts": accounts,
    }


EVALUATION_WINDOW_SECONDS = 900
REPORT_COOLDOWN_SECONDS = 60


@pytest.fixture
def fresh(deployment, sim):
    """
    Put the deployed system into a known state before each test.

    glsim's `sim_createSnapshot` records only which contracts exist, not their
    storage values (`create_snapshot` deep-copies accounts and key sets; storage
    is untouched), so restoring it does NOT roll back contract state. Isolation
    is therefore achieved with the contracts' own public API instead:

      1. advance past the evaluation window, so any incident left open by a
         previous test can be retired and the reporter cooldown has lapsed;
      2. expire every non-terminal incident, freeing open-incident slots;
      3. clear any active response, returning the protocol to NORMAL and
         resetting the escalation counter, and reset the demo simulation
         overlay so telemetry starts from baseline.

    Nothing here is a back door: `expire_incident` is permissionless by design
    and `clear_response` is the owner's documented false-positive override.
    """
    sim.increase_time(EVALUATION_WINDOW_SECONDS + REPORT_COOLDOWN_SECONDS + 10)

    shield = deployment["shield"]
    for incident_id in shield.list_incidents(args=[]).call():
        record = shield.get_incident(args=[incident_id]).call()
        if record["status"] in ("READY", "EVALUATED"):
            shield.expire_incident(args=[incident_id]).transact()

    owner_protocol = deployment["protocol"].connect(deployment["owner"])
    owner_protocol.clear_response(args=[]).transact()
    owner_protocol.reset_simulation(args=[]).transact()

    yield deployment


# ---------------------------------------------------------------------------
# Scenario helpers
# ---------------------------------------------------------------------------

_counter = {"n": 0}


def unique_hash() -> str:
    _counter["n"] += 1
    return "0x" + f"{_counter['n']:064x}"


def contract_now(deployment) -> int:
    """The protocol's own clock, which is the one the contracts reason about."""
    return deployment["protocol"].get_status(args=[]).call()["now_ts"]


def file_incident(deployment, *, category="ORACLE_DEVIATION", metadata="{}",
                  observed_offset=0, uri="ipfs://evidence"):
    """Submit an incident as the authorised reporter; returns (id, receipt)."""
    shield = deployment["shield"].connect(deployment["reporter"])
    observed_at = contract_now(deployment) + observed_offset
    receipt = shield.report_incident(
        args=[category, observed_at, unique_hash(), uri, metadata]
    ).transact()
    assert_ok(receipt, "report_incident")
    incident_ids = deployment["shield"].list_incidents(args=[]).call()
    return incident_ids[-1], receipt


def adjudicate(deployment, sim, incident_id, severity, bits=0, **overrides):
    """
    Install an evaluator response, then adjudicate through consensus.

    The extra read between installing and adjudicating is load-bearing.
    `sim_installMocks` replaces the node's persistent mock dict but *appends* to
    the live mock list, and `_match_llm_mock` returns the FIRST pattern that
    matches. Since every evaluator mock matches the same prompt, a stale entry
    would win and the previous test's verdict would be returned. The node
    rebuilds the live list from the persistent dict in the `finally` of each
    transaction, so one throwaway call collapses it to exactly the newest mock.
    """
    if not LIVE_LLM:
        sim.install_evaluator(verdict_json(severity, bits, **overrides))
        deployment["shield"].get_config(args=[]).call()

    shield = deployment["shield"].connect(deployment["evaluator"])
    return shield.adjudicate(args=[incident_id]).transact()


def incident(deployment, incident_id) -> dict:
    return deployment["shield"].get_incident(args=[incident_id]).call()
