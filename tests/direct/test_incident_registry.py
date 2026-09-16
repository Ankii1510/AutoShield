"""
AutoShield incident intake: authorization, evidence discipline, and anti-spam.

Every rejection here is deterministic and happens before any expensive work,
which is what makes incident spam unattractive rather than merely rate-limited.
"""

import pytest

from conftest import (
    adjudicate_with,
    FRESHNESS_WINDOW_SECONDS,
    MAX_OPEN_INCIDENTS,
    MAX_REPORTS_PER_WINDOW,
    REPORT_COOLDOWN_SECONDS,
    addr,
    report,
)

HASH_A = "0x" + "ab" * 32
HASH_B = "0x" + "cd" * 32


# ---------------------------------------------------------------------------
# Authorization
# ---------------------------------------------------------------------------


def test_unauthorized_reporter_is_rejected(direct_vm, shield, direct_charlie, at_t0):
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Not an authorized reporter"):
        shield.report_incident("ORACLE_DEVIATION", at_t0, HASH_A, "", "{}")


def test_owner_can_add_and_remove_reporters(
    direct_vm, shield, direct_owner, direct_charlie, at_t0
):
    direct_vm.sender = direct_owner
    shield.set_reporter(addr(direct_charlie), True)
    assert shield.is_reporter(addr(direct_charlie)) is True

    incident_id = report(shield, direct_vm, direct_charlie, at_t0)
    assert incident_id == "INC-1"

    direct_vm.sender = direct_owner
    shield.set_reporter(addr(direct_charlie), False)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Not an authorized reporter"):
        shield.report_incident("ORACLE_DEVIATION", at_t0, HASH_B, "", "{}")


def test_only_owner_manages_reporters(direct_vm, shield, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Only owner"):
        shield.set_reporter(addr(direct_alice), True)


def test_paused_shield_refuses_intake(
    direct_vm, shield, direct_owner, direct_alice, at_t0
):
    direct_vm.sender = direct_owner
    shield.set_paused(True)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("AutoShield is paused"):
        shield.report_incident("ORACLE_DEVIATION", at_t0, HASH_A, "", "{}")


# ---------------------------------------------------------------------------
# Evidence discipline
# ---------------------------------------------------------------------------


def test_incident_record_is_compact_and_complete(
    direct_vm, shield, direct_alice, at_t0
):
    incident_id = report(
        shield, direct_vm, direct_alice, at_t0 - 30,
        category="LIQUIDITY_DRAIN", evidence_hash=HASH_A,
        uri="ipfs://bundle", metadata='{"liquidity_delta_bps":4400}',
    )
    incident = shield.get_incident(incident_id)

    assert incident["incident_id"] == "INC-1"
    assert incident["reporter"] == addr(direct_alice).as_hex
    assert incident["category"] == "LIQUIDITY_DRAIN"
    assert incident["evidence_hash"] == HASH_A
    assert incident["evidence_uri"] == "ipfs://bundle"
    assert incident["metadata_json"] == '{"liquidity_delta_bps":4400}'
    assert incident["observed_at_ts"] == at_t0 - 30
    assert incident["created_at_ts"] == at_t0
    assert incident["status"] == "READY"
    assert incident["severity"] == 0
    assert incident["signals_bits"] == 0
    assert incident["level"] == ""
    assert incident["deadline_ts"] == 0
    assert incident["executed"] is False


def test_unknown_category_is_rejected(direct_vm, shield, direct_alice, at_t0):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Unknown category"):
        shield.report_incident("VIBES", at_t0, HASH_A, "", "{}")


def test_missing_evidence_hash_is_rejected(direct_vm, shield, direct_alice, at_t0):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Invalid evidence hash"):
        shield.report_incident("ORACLE_DEVIATION", at_t0, "", "", "{}")


def test_oversized_payloads_are_rejected(direct_vm, shield, direct_alice, at_t0):
    """Bulk evidence never goes on-chain — only a hash, a pointer and metadata."""
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Invalid evidence hash"):
        shield.report_incident("ORACLE_DEVIATION", at_t0, "0x" + "a" * 200, "", "{}")

    with direct_vm.expect_revert("Evidence URI too long"):
        shield.report_incident("ORACLE_DEVIATION", at_t0, HASH_A, "x" * 300, "{}")

    with direct_vm.expect_revert("Metadata too long"):
        shield.report_incident("ORACLE_DEVIATION", at_t0, HASH_A, "", "y" * 600)


# ---------------------------------------------------------------------------
# Freshness
# ---------------------------------------------------------------------------


def test_stale_evidence_is_rejected(direct_vm, shield, direct_alice, at_t0):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Evidence is stale"):
        shield.report_incident(
            "ORACLE_DEVIATION", at_t0 - FRESHNESS_WINDOW_SECONDS - 1, HASH_A, "", "{}"
        )


def test_evidence_at_the_freshness_boundary_is_accepted(
    direct_vm, shield, direct_alice, at_t0
):
    incident_id = report(
        shield, direct_vm, direct_alice, at_t0 - FRESHNESS_WINDOW_SECONDS
    )
    assert shield.get_incident(incident_id)["status"] == "READY"


def test_future_dated_evidence_is_rejected(direct_vm, shield, direct_alice, at_t0):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Evidence is future-dated"):
        shield.report_incident("ORACLE_DEVIATION", at_t0 + 1, HASH_A, "", "{}")


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------


def test_identical_resubmission_is_rejected(
    direct_vm, shield, direct_alice, at_t0, warp
):
    report(shield, direct_vm, direct_alice, at_t0)

    warp(at_t0 + REPORT_COOLDOWN_SECONDS)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Duplicate incident"):
        shield.report_incident("ORACLE_DEVIATION", at_t0, HASH_A, "ipfs://evidence", "{}")


def test_timestamp_nudging_does_not_defeat_dedup(
    direct_vm, shield, direct_alice, at_t0, warp
):
    """
    The dedup key buckets the observation time, so shifting it by a second
    does not mint a fresh incident.
    """
    report(shield, direct_vm, direct_alice, at_t0)

    warp(at_t0 + REPORT_COOLDOWN_SECONDS)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Duplicate incident"):
        shield.report_incident(
            "ORACLE_DEVIATION", at_t0 + 1, HASH_A, "ipfs://evidence", "{}"
        )


def test_different_evidence_is_not_a_duplicate(
    direct_vm, shield, direct_alice, at_t0, warp
):
    first = report(shield, direct_vm, direct_alice, at_t0, evidence_hash=HASH_A)
    warp(at_t0 + REPORT_COOLDOWN_SECONDS)
    second = report(shield, direct_vm, direct_alice, at_t0, evidence_hash=HASH_B)
    assert [first, second] == ["INC-1", "INC-2"]


def test_different_category_is_not_a_duplicate(
    direct_vm, shield, direct_alice, at_t0, warp
):
    report(shield, direct_vm, direct_alice, at_t0, category="ORACLE_DEVIATION")
    warp(at_t0 + REPORT_COOLDOWN_SECONDS)
    second = report(shield, direct_vm, direct_alice, at_t0, category="TX_PATTERN")
    assert second == "INC-2"


def test_incident_ids_are_unique_and_monotonic(
    direct_vm, shield, direct_alice, at_t0, warp
):
    ids = []
    for index in range(5):
        moment = warp(at_t0 + index * REPORT_COOLDOWN_SECONDS)
        ids.append(
            report(shield, direct_vm, direct_alice, moment,
                   evidence_hash="0x" + f"{index:02x}" * 32)
        )
    assert ids == ["INC-1", "INC-2", "INC-3", "INC-4", "INC-5"]
    assert len(set(ids)) == 5
    assert shield.list_incidents() == ids


# ---------------------------------------------------------------------------
# Anti-spam
# ---------------------------------------------------------------------------


def _dismiss(shield, direct_vm, incident_id):
    """Evaluate an incident as SAFE so it leaves the open set."""
    evaluator_hex = shield.get_config()["evaluator"]
    adjudicate_with(
        shield, direct_vm, bytes.fromhex(evaluator_hex[2:]), incident_id, 0, 0
    )



def test_reporter_cooldown_is_enforced(direct_vm, shield, direct_alice, at_t0, warp):
    report(shield, direct_vm, direct_alice, at_t0)

    warp(at_t0 + REPORT_COOLDOWN_SECONDS - 1)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Reporter cooldown active"):
        shield.report_incident("ORACLE_DEVIATION", at_t0, HASH_B, "", "{}")

    moment = warp(at_t0 + REPORT_COOLDOWN_SECONDS)
    assert report(shield, direct_vm, direct_alice, moment, evidence_hash=HASH_B) == "INC-2"


def test_open_incident_cap_is_enforced(
    direct_vm, shield, direct_owner, direct_alice, direct_charlie, at_t0, warp
):
    direct_vm.sender = direct_owner
    shield.set_reporter(addr(direct_charlie), True)

    reporters = [direct_alice, direct_charlie]
    moment = at_t0
    for index in range(MAX_OPEN_INCIDENTS):
        moment = warp(at_t0 + index * REPORT_COOLDOWN_SECONDS)
        report(
            shield, direct_vm, reporters[index % 2], moment,
            evidence_hash="0x" + f"{index:02x}" * 32,
        )

    moment = warp(moment + REPORT_COOLDOWN_SECONDS)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Too many open incidents"):
        shield.report_incident("ORACLE_DEVIATION", moment, "0x" + "ff" * 32, "", "{}")


def test_global_rate_window_is_enforced(
    direct_vm, shield, direct_owner, direct_alice, direct_charlie, at_t0, warp
):
    """
    The global cap binds even when the per-reporter cooldown and the open
    incident cap do not, because incidents are being evaluated as they arrive.
    """
    direct_vm.sender = direct_owner
    shield.set_reporter(addr(direct_charlie), True)
    evaluator = shield.get_config()["evaluator"]
    assert evaluator  # sanity: the seam exists

    reporters = [direct_alice, direct_charlie]
    moment = at_t0
    for index in range(MAX_REPORTS_PER_WINDOW):
        moment = warp(at_t0 + index * REPORT_COOLDOWN_SECONDS)
        incident_id = report(
            shield, direct_vm, reporters[index % 2], moment,
            evidence_hash="0x" + f"{index:02x}" * 32,
        )
        # Resolve immediately so the open-incident cap never binds first.
        _dismiss(shield, direct_vm, incident_id)

    moment = warp(moment + REPORT_COOLDOWN_SECONDS)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Global rate limit reached"):
        shield.report_incident("ORACLE_DEVIATION", moment, "0x" + "ff" * 32, "", "{}")
