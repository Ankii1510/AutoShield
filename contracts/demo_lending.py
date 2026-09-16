# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
"""
DemoLendingProtocol -- the protected protocol for the AutoShield demo.

This contract is 100% DETERMINISTIC. It contains no `gl.nondet.*` call of any
kind and it never asks an LLM anything. All judgment lives in AutoShield.

It is a *controlled demo* of a lending market: supply / borrow / repay /
withdraw against a mock oracle, using internal accounting units rather than
real value. It contains no exploit code, no attack primitives, and it does not
interact with any external protocol. The `simulate_*` methods only move this
contract's own reported telemetry into an anomalous-looking state so the demo
has something for AutoShield to judge; they never corrupt real accounting.

The security posture of this contract is deliberately *defensive toward
AutoShield*. It grants exactly one external authority -- `guard_address` -- and
that authority may only ever do one thing: narrow the set of permitted user
operations, for a bounded time. It can never move value, change the oracle,
change ownership, or halt the protocol indefinitely. See `apply_response` and
`_effective_mode` for the enforcement of those bounds.
"""

import datetime
from dataclasses import dataclass

import genlayer as gl
from genlayer import Address, u256
from genlayer.storage import DynArray, TreeMap
from genlayer.storage import allow as allow_storage

# `Contract` and `Event` are deliberately NOT imported as bare module-level
# names. gltest's direct-mode loader finds the contract class by scanning
# `dir(module)` for the first class with `Contract` in its MRO -- a bare
# `Contract` import satisfies that test itself and gets deployed instead of
# the real contract, which fails as "class is not marked for usage within
# storage". The qualified spellings below are also the SDK's documented form.


# --------------------------------------------------------------------------
# Error classification prefixes (see genlayer-dev/write-contract skill).
# Deterministic business-logic failures must compare equal across validators.
# --------------------------------------------------------------------------
ERROR_EXPECTED = "[EXPECTED]"

# --------------------------------------------------------------------------
# Operating modes. Stored as `str` -- Enum is not a supported storage type.
# --------------------------------------------------------------------------
MODE_NORMAL = "NORMAL"
MODE_RESTRICTED = "RESTRICTED"
MODE_HALTED = "HALTED"

# Response levels accepted from the guard. SAFE is never applied on-chain:
# it is the absence of a response, and AutoShield resolves it without calling
# this contract at all.
LEVEL_PROTECT = "PROTECT"
LEVEL_HALT = "HALT"

# --------------------------------------------------------------------------
# Fixed-point / accounting constants.
# All value is integer atto-scale (1e18). No float ever crosses a boundary:
# floats are software-emulated in deterministic GenVM blocks and are a
# consensus hazard in non-deterministic ones.
# --------------------------------------------------------------------------
ONE_ATTO = 10**18
BPS_DENOMINATOR = 10000

# Loan-to-value ceiling: a position may borrow up to 75% of collateral value.
LTV_BPS = 7500

# --------------------------------------------------------------------------
# Anti-brick bounds. These are enforced by THIS contract against the guard,
# not merely promised by AutoShield.
# --------------------------------------------------------------------------
# No single response may hold the protocol for longer than this, whatever
# deadline the guard asks for.
MAX_RESPONSE_TTL_SECONDS = 7200  # 2 hours

# When a HALT lapses it decays to RESTRICTED for this long, and only then to
# NORMAL. A genuine ongoing exploit therefore still faces a borrow freeze
# after the halt window; a false positive costs at most the halt window of
# full freeze.
HALT_DECAY_TO_RESTRICTED_SECONDS = 1800  # 30 minutes

# A run of halts without the protocol ever returning to NORMAL is capped.
# Beyond this, further HALT requests are downgraded to PROTECT, so no
# sequence of AutoShield actions can chain halts indefinitely.
MAX_CONSECUTIVE_HALTS = 3

# While RESTRICTED, a user may withdraw at most this share of their position
# per incident. Withdrawals are slowed, never blocked.
RESTRICTED_WITHDRAW_CAP_BPS = 2000  # 20%

# Guard rotation timelock, in seconds.
GUARD_ROTATION_DELAY_SECONDS = 86400  # 24 hours


# --------------------------------------------------------------------------
# Deterministic time helpers.
#
# GenVM exposes NO block timestamp. The only clock available to a contract is
# `gl.message.raw["datetime"]`, an ISO-8601 string carrying the transaction
# datetime. Everything time-dependent in this contract derives from it, and
# every deadline is stored as an ABSOLUTE unix second, never as a duration --
# a duration would let a delayed message silently extend a response.
# --------------------------------------------------------------------------
_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


def _iso_to_ts(value: str) -> int:
    """Parse an ISO-8601 datetime into unix seconds using integer math only."""
    text = value.strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except ValueError:
        raise gl.vm.UserError(f"{ERROR_EXPECTED} Malformed datetime")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    delta = parsed - _EPOCH
    # timedelta.days / .seconds are ints -- no float, no rounding drift.
    return delta.days * 86400 + delta.seconds


def _now_ts() -> int:
    """Current transaction time, in unix seconds."""
    return _iso_to_ts(gl.message.raw["datetime"])


@allow_storage
@dataclass
class Position:
    """A user's supply/borrow position, in atto units."""

    deposited_atto: u256
    debt_atto: u256


# --------------------------------------------------------------------------
# Events
# --------------------------------------------------------------------------
class DepositMade(gl.chain.Event):
    def __init__(self, user: Address, /, **blob): ...


class WithdrawalMade(gl.chain.Event):
    def __init__(self, user: Address, /, **blob): ...


class BorrowMade(gl.chain.Event):
    def __init__(self, user: Address, /, **blob): ...


class RepaymentMade(gl.chain.Event):
    def __init__(self, user: Address, /, **blob): ...


class ProtocolProtected(gl.chain.Event):
    """Emitted when the protocol enters RESTRICTED via a PROTECT response."""

    def __init__(self, incident_id: str, /, **blob): ...


class ProtocolHalted(gl.chain.Event):
    """Emitted when the protocol enters HALTED via a HALT response."""

    def __init__(self, incident_id: str, /, **blob): ...


class ProtectionExpired(gl.chain.Event):
    """Emitted when a response lapses and the mode decays."""

    def __init__(self, incident_id: str, /, **blob): ...


class ResponseCleared(gl.chain.Event):
    """Emitted when the owner releases a response early."""

    def __init__(self, incident_id: str, /, **blob): ...


class GuardRotationProposed(gl.chain.Event):
    def __init__(self, proposed: Address, /, **blob): ...


class GuardRotated(gl.chain.Event):
    def __init__(self, guard: Address, /, **blob): ...


class DemoLendingProtocol(gl.contract.Contract):
    # ---- authority -------------------------------------------------------
    owner: Address
    guard_address: Address
    pending_guard: Address
    pending_guard_eta_ts: u256
    guard_initialized: bool

    # ---- emergency state -------------------------------------------------
    mode: str
    mode_deadline_ts: u256
    active_incident_id: str
    consecutive_halts: u256
    applied_incidents: TreeMap[str, bool]
    restricted_withdrawn: TreeMap[str, u256]

    # ---- market state ----------------------------------------------------
    wallet_atto: TreeMap[Address, u256]
    positions: TreeMap[Address, Position]
    account_index: DynArray[Address]
    known_account: TreeMap[Address, bool]
    total_deposits_atto: u256
    total_borrowed_atto: u256
    total_minted_atto: u256

    # ---- oracle ----------------------------------------------------------
    oracle_price_atto: u256
    baseline_price_atto: u256
    oracle_updated_ts: u256

    # ---- demo-only telemetry overlay (never touches real accounting) -----
    sim_borrow_volume_bps: u256
    sim_liquidity_drain_bps: u256
    sim_tx_count: u256
    sim_unique_senders: u256
    sim_top_sender_share_bps: u256

    def __init__(self, initial_price_atto: u256) -> None:
        if int(initial_price_atto) <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Price must be positive")

        self.owner = gl.message.sender_address
        self.guard_address = Address(bytes(20))
        self.pending_guard = Address(bytes(20))
        self.pending_guard_eta_ts = u256(0)
        self.guard_initialized = False

        self.mode = MODE_NORMAL
        self.mode_deadline_ts = u256(0)
        self.active_incident_id = ""
        self.consecutive_halts = u256(0)

        self.total_deposits_atto = u256(0)
        self.total_borrowed_atto = u256(0)
        self.total_minted_atto = u256(0)

        self.oracle_price_atto = u256(int(initial_price_atto))
        self.baseline_price_atto = u256(int(initial_price_atto))
        self.oracle_updated_ts = u256(_now_ts())

        self.sim_borrow_volume_bps = u256(0)
        self.sim_liquidity_drain_bps = u256(0)
        self.sim_tx_count = u256(0)
        self.sim_unique_senders = u256(0)
        self.sim_top_sender_share_bps = u256(0)

    # ======================================================================
    # Internal: authority
    # ======================================================================

    def _only_owner(self) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only owner")

    def _only_guard(self) -> None:
        if not self.guard_initialized:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Guard not set")
        if gl.message.sender_address != self.guard_address:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only guard")

    # ======================================================================
    # Internal: lazy mode decay -- the anti-brick mechanism
    # ======================================================================

    def _compute_mode(self, now_ts: int) -> tuple:
        """
        Pure: the mode that is actually in force at `now_ts`, given stored state.

        Decay ladder, evaluated without any transaction being required:

            HALTED --(deadline)--> RESTRICTED --(+decay window)--> NORMAL
            RESTRICTED --(deadline)--> NORMAL

        Because this is computed on every read and before every gated write,
        the protocol un-sticks itself with no cooperation from AutoShield, the
        guard, the owner, or any keeper.
        """
        stored_mode = self.mode
        if stored_mode == MODE_NORMAL:
            return (MODE_NORMAL, 0)

        deadline = int(self.mode_deadline_ts)
        if now_ts < deadline:
            return (stored_mode, deadline)

        if stored_mode == MODE_HALTED:
            decayed_deadline = deadline + HALT_DECAY_TO_RESTRICTED_SECONDS
            if now_ts < decayed_deadline:
                return (MODE_RESTRICTED, decayed_deadline)
            return (MODE_NORMAL, 0)

        # RESTRICTED past its deadline.
        return (MODE_NORMAL, 0)

    def _settle_mode(self, now_ts: int) -> str:
        """Persist any decay that has already happened, then return the mode."""
        effective, deadline = self._compute_mode(now_ts)
        if effective != self.mode or deadline != int(self.mode_deadline_ts):
            previous_incident = self.active_incident_id
            self.mode = effective
            self.mode_deadline_ts = u256(deadline)
            if effective == MODE_NORMAL:
                self.active_incident_id = ""
                # A full return to NORMAL is what resets the escalation budget.
                self.consecutive_halts = u256(0)
            if previous_incident != "":
                ProtectionExpired(
                    previous_incident,
                    decayed_to=effective,
                    at_ts=now_ts,
                ).emit()
        return effective

    # ======================================================================
    # Internal: operation gating
    # ======================================================================

    def _require_can_supply(self, mode: str) -> None:
        if mode == MODE_HALTED:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Supply disabled while halted")

    def _require_can_borrow(self, mode: str) -> None:
        if mode != MODE_NORMAL:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Borrowing disabled in {mode}")

    def _require_can_withdraw(self, mode: str) -> None:
        if mode == MODE_HALTED:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Withdrawals disabled while halted")

    # NOTE: there is deliberately no `_require_can_repay`. Repayment is
    # unconditional in every mode. A borrower must always be able to reduce
    # their own risk, including during a false-positive halt.

    def _withdraw_budget_key(self, user: Address) -> str:
        return self.active_incident_id + ":" + user.as_hex

    def _enforce_restricted_withdraw_cap(self, user: Address, amount_atto: int) -> None:
        """
        While RESTRICTED, cap cumulative withdrawals per incident per user.

        The cap is a share of the user's exposure at the start of the incident,
        reconstructed as (current deposit + already withdrawn under this
        incident) so that repeated small withdrawals cannot walk past it.
        """
        key = self._withdraw_budget_key(user)
        already = int(self.restricted_withdrawn.get(key, u256(0)))
        position = self.positions.get(user, Position(u256(0), u256(0)))
        base = int(position.deposited_atto) + already
        allowance = base * RESTRICTED_WITHDRAW_CAP_BPS // BPS_DENOMINATOR
        if already + amount_atto > allowance:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} Withdrawal exceeds restricted-mode cap"
            )
        self.restricted_withdrawn[key] = u256(already + amount_atto)

    def _touch_account(self, user: Address) -> None:
        if not self.known_account.get(user, False):
            self.known_account[user] = True
            self.account_index.append(user)

    def _collateral_capacity_atto(self, position: Position) -> int:
        """Maximum debt this position may carry at the current oracle price."""
        collateral_value = (
            int(position.deposited_atto) * int(self.oracle_price_atto) // ONE_ATTO
        )
        return collateral_value * LTV_BPS // BPS_DENOMINATOR

    # ======================================================================
    # Views
    # ======================================================================

    @gl.public.view
    def get_mode(self) -> str:
        """Effective mode right now, accounting for decay that has not yet been written."""
        return self._compute_mode(_now_ts())[0]

    @gl.public.view
    def get_status(self) -> dict:
        now_ts = _now_ts()
        effective, deadline = self._compute_mode(now_ts)
        return {
            "mode": effective,
            "stored_mode": self.mode,
            "mode_deadline_ts": deadline,
            "seconds_remaining": max(0, deadline - now_ts) if deadline else 0,
            "active_incident_id": self.active_incident_id if effective != MODE_NORMAL else "",
            "consecutive_halts": int(self.consecutive_halts),
            "guard_address": self.guard_address.as_hex,
            "owner": self.owner.as_hex,
            "now_ts": now_ts,
            "borrow_enabled": effective == MODE_NORMAL,
            "supply_enabled": effective != MODE_HALTED,
            "withdraw_enabled": effective != MODE_HALTED,
            "repay_enabled": True,
        }

    @gl.public.view
    def telemetry(self) -> dict:
        """
        The protocol's own live metrics -- the authoritative evidence source.

        AutoShield reads this directly rather than trusting a reporter's copy;
        the divergence between the two is itself a dishonesty signal. Every
        value is an integer (basis points or atto units).
        """
        now_ts = _now_ts()
        price = int(self.oracle_price_atto)
        baseline = int(self.baseline_price_atto)
        deviation_bps = 0
        if baseline > 0:
            diff = price - baseline if price > baseline else baseline - price
            deviation_bps = diff * BPS_DENOMINATOR // baseline

        deposits = int(self.total_deposits_atto)
        borrowed = int(self.total_borrowed_atto)
        utilisation_bps = borrowed * BPS_DENOMINATOR // deposits if deposits > 0 else 0

        return {
            "price_atto": price,
            "baseline_atto": baseline,
            "deviation_bps": deviation_bps,
            "seconds_since_update": max(0, now_ts - int(self.oracle_updated_ts)),
            "total_deposits_atto": deposits,
            "total_borrowed_atto": borrowed,
            "available_liquidity_atto": max(0, deposits - borrowed),
            "utilisation_bps": utilisation_bps,
            "window_volume_bps": int(self.sim_borrow_volume_bps),
            "liquidity_delta_bps": int(self.sim_liquidity_drain_bps),
            "tx_count": int(self.sim_tx_count),
            "unique_senders": int(self.sim_unique_senders),
            "top_sender_share_bps": int(self.sim_top_sender_share_bps),
            "mode": self._compute_mode(now_ts)[0],
            "now_ts": now_ts,
        }

    @gl.public.view
    def get_position(self, user: Address) -> dict:
        position = self.positions.get(user, Position(u256(0), u256(0)))
        return {
            "deposited_atto": int(position.deposited_atto),
            "debt_atto": int(position.debt_atto),
            "wallet_atto": int(self.wallet_atto.get(user, u256(0))),
            "borrow_capacity_atto": self._collateral_capacity_atto(position),
        }

    @gl.public.view
    def list_accounts(self) -> list:
        return [addr.as_hex for addr in self.account_index]

    @gl.public.view
    def conservation_check(self) -> dict:
        """
        Accounting invariant, exposed for auditing and tests:

            sum(wallets) + total_deposits - total_borrowed == total_minted

        AutoShield cannot influence any term of this equation.
        """
        wallet_sum = 0
        for addr in self.account_index:
            wallet_sum += int(self.wallet_atto.get(addr, u256(0)))
        expected = int(self.total_minted_atto)
        actual = wallet_sum + int(self.total_deposits_atto) - int(self.total_borrowed_atto)
        return {"expected": expected, "actual": actual, "balanced": expected == actual}

    @gl.public.view
    def was_incident_applied(self, incident_id: str) -> bool:
        return bool(self.applied_incidents.get(incident_id, False))

    # ======================================================================
    # User operations
    # ======================================================================

    @gl.public.write
    def mint_demo_balance(self, user: Address, amount_atto: u256) -> None:
        """Owner-only demo faucet. The only way units enter the system."""
        self._only_owner()
        amount = int(amount_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Amount must be positive")
        self._touch_account(user)
        self.wallet_atto[user] = u256(int(self.wallet_atto.get(user, u256(0))) + amount)
        self.total_minted_atto = u256(int(self.total_minted_atto) + amount)

    @gl.public.write
    def deposit(self, amount_atto: u256) -> None:
        now_ts = _now_ts()
        mode = self._settle_mode(now_ts)
        self._require_can_supply(mode)

        sender = gl.message.sender_address
        amount = int(amount_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Amount must be positive")

        balance = int(self.wallet_atto.get(sender, u256(0)))
        if balance < amount:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Insufficient wallet balance")

        self._touch_account(sender)
        self.wallet_atto[sender] = u256(balance - amount)
        position = self.positions.get(sender, Position(u256(0), u256(0)))
        self.positions[sender] = Position(
            deposited_atto=u256(int(position.deposited_atto) + amount),
            debt_atto=position.debt_atto,
        )
        self.total_deposits_atto = u256(int(self.total_deposits_atto) + amount)
        DepositMade(sender, amount_atto=amount, at_ts=now_ts).emit()

    @gl.public.write
    def withdraw(self, amount_atto: u256) -> None:
        now_ts = _now_ts()
        mode = self._settle_mode(now_ts)
        self._require_can_withdraw(mode)

        sender = gl.message.sender_address
        amount = int(amount_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Amount must be positive")

        position = self.positions.get(sender, Position(u256(0), u256(0)))
        if int(position.deposited_atto) < amount:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Insufficient deposit")

        remaining_deposit = int(position.deposited_atto) - amount
        remaining_capacity = (
            remaining_deposit * int(self.oracle_price_atto) // ONE_ATTO
        ) * LTV_BPS // BPS_DENOMINATOR
        if int(position.debt_atto) > remaining_capacity:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Withdrawal breaks collateral ratio")

        available = int(self.total_deposits_atto) - int(self.total_borrowed_atto)
        if available < amount:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Insufficient protocol liquidity")

        if mode == MODE_RESTRICTED:
            self._enforce_restricted_withdraw_cap(sender, amount)

        self.positions[sender] = Position(
            deposited_atto=u256(remaining_deposit),
            debt_atto=position.debt_atto,
        )
        self.wallet_atto[sender] = u256(
            int(self.wallet_atto.get(sender, u256(0))) + amount
        )
        self.total_deposits_atto = u256(int(self.total_deposits_atto) - amount)
        WithdrawalMade(sender, amount_atto=amount, at_ts=now_ts).emit()

    @gl.public.write
    def borrow(self, amount_atto: u256) -> None:
        now_ts = _now_ts()
        mode = self._settle_mode(now_ts)
        self._require_can_borrow(mode)

        sender = gl.message.sender_address
        amount = int(amount_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Amount must be positive")

        position = self.positions.get(sender, Position(u256(0), u256(0)))
        new_debt = int(position.debt_atto) + amount
        if new_debt > self._collateral_capacity_atto(position):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Exceeds collateral capacity")

        available = int(self.total_deposits_atto) - int(self.total_borrowed_atto)
        if available < amount:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Insufficient protocol liquidity")

        self._touch_account(sender)
        self.positions[sender] = Position(
            deposited_atto=position.deposited_atto,
            debt_atto=u256(new_debt),
        )
        self.wallet_atto[sender] = u256(
            int(self.wallet_atto.get(sender, u256(0))) + amount
        )
        self.total_borrowed_atto = u256(int(self.total_borrowed_atto) + amount)
        BorrowMade(sender, amount_atto=amount, at_ts=now_ts).emit()

    @gl.public.write
    def repay(self, amount_atto: u256) -> None:
        """
        Repay debt. NEVER gated by mode -- not in RESTRICTED, not in HALTED.

        This is a core anti-brick guarantee: an emergency response must never
        trap a borrower in a position they are trying to close.
        """
        now_ts = _now_ts()
        self._settle_mode(now_ts)  # keep decay current, but do not gate on it

        sender = gl.message.sender_address
        amount = int(amount_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Amount must be positive")

        position = self.positions.get(sender, Position(u256(0), u256(0)))
        if int(position.debt_atto) < amount:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Repayment exceeds debt")

        balance = int(self.wallet_atto.get(sender, u256(0)))
        if balance < amount:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Insufficient wallet balance")

        self.wallet_atto[sender] = u256(balance - amount)
        self.positions[sender] = Position(
            deposited_atto=position.deposited_atto,
            debt_atto=u256(int(position.debt_atto) - amount),
        )
        self.total_borrowed_atto = u256(int(self.total_borrowed_atto) - amount)
        RepaymentMade(sender, amount_atto=amount, at_ts=now_ts).emit()

    # ======================================================================
    # Emergency response surface -- the ONLY authority granted to AutoShield
    # ======================================================================

    @gl.public.write
    def apply_response(
        self,
        incident_id: str,
        level: str,
        deadline_ts: u256,
        severity: u256,
    ) -> str:
        """
        Apply a protective response. Callable ONLY by `guard_address`.

        This method re-validates every argument rather than trusting the guard:
        unknown levels, replayed incident ids, deadlines in the past or beyond
        `MAX_RESPONSE_TTL_SECONDS`, and halts beyond the escalation ceiling are
        all rejected or clamped here. It cannot move value, change the oracle,
        change ownership, or set an unbounded deadline -- there is no code path
        from this method to any of those.

        Returns the level actually applied, which may be a downgrade of the
        level requested.
        """
        self._only_guard()

        now_ts = _now_ts()

        if incident_id == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Incident id required")
        if bool(self.applied_incidents.get(incident_id, False)):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Incident already applied")
        if level not in (LEVEL_PROTECT, LEVEL_HALT):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Unknown response level")

        severity_value = int(severity)
        if severity_value < 0 or severity_value > 100:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Severity out of range")

        requested_deadline = int(deadline_ts)
        if requested_deadline <= now_ts:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Response already expired")
        # Ceiling, not a rejection: a guard asking for too much gets clamped.
        max_deadline = now_ts + MAX_RESPONSE_TTL_SECONDS
        effective_deadline = min(requested_deadline, max_deadline)

        # Settle decay first so escalation decisions use the true current mode.
        current_mode = self._settle_mode(now_ts)

        applied_level = level
        if level == LEVEL_HALT and int(self.consecutive_halts) >= MAX_CONSECUTIVE_HALTS:
            # Escalation ceiling reached: downgrade rather than chain halts.
            applied_level = LEVEL_PROTECT

        target_mode = MODE_HALTED if applied_level == LEVEL_HALT else MODE_RESTRICTED

        # A PROTECT request must never silently relax an active HALT into a
        # weaker mode with a *longer* life than the halt already had.
        if current_mode == MODE_HALTED and target_mode == MODE_RESTRICTED:
            effective_deadline = max(effective_deadline, int(self.mode_deadline_ts))

        if target_mode == MODE_HALTED:
            self.consecutive_halts = u256(int(self.consecutive_halts) + 1)

        self.applied_incidents[incident_id] = True
        self.mode = target_mode
        self.mode_deadline_ts = u256(effective_deadline)
        self.active_incident_id = incident_id

        if target_mode == MODE_HALTED:
            ProtocolHalted(
                incident_id,
                severity=severity_value,
                deadline_ts=effective_deadline,
                requested_level=level,
            ).emit()
        else:
            ProtocolProtected(
                incident_id,
                severity=severity_value,
                deadline_ts=effective_deadline,
                requested_level=level,
            ).emit()

        return applied_level

    @gl.public.write
    def clear_response(self) -> None:
        """Owner-only immediate release. The manual override for false positives."""
        self._only_owner()
        cleared = self.active_incident_id
        self.mode = MODE_NORMAL
        self.mode_deadline_ts = u256(0)
        self.active_incident_id = ""
        self.consecutive_halts = u256(0)
        ResponseCleared(cleared, at_ts=_now_ts()).emit()

    # ======================================================================
    # Guard management
    # ======================================================================

    @gl.public.write
    def set_initial_guard(self, guard: Address) -> None:
        """One-shot genesis wiring. Refuses to act once a guard exists."""
        self._only_owner()
        if self.guard_initialized:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Guard already initialized")
        if guard == Address(bytes(20)):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Guard cannot be zero address")
        self.guard_address = guard
        self.guard_initialized = True
        GuardRotated(guard, at_ts=_now_ts(), initial=True).emit()

    @gl.public.write
    def propose_guard(self, guard: Address) -> None:
        self._only_owner()
        if guard == Address(bytes(20)):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Guard cannot be zero address")
        eta = _now_ts() + GUARD_ROTATION_DELAY_SECONDS
        self.pending_guard = guard
        self.pending_guard_eta_ts = u256(eta)
        GuardRotationProposed(guard, eta_ts=eta).emit()

    @gl.public.write
    def accept_guard(self) -> None:
        self._only_owner()
        if self.pending_guard == Address(bytes(20)):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} No pending guard")
        if _now_ts() < int(self.pending_guard_eta_ts):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Guard timelock not elapsed")
        self.guard_address = self.pending_guard
        self.guard_initialized = True
        self.pending_guard = Address(bytes(20))
        self.pending_guard_eta_ts = u256(0)
        GuardRotated(self.guard_address, at_ts=_now_ts(), initial=False).emit()

    # ======================================================================
    # Oracle
    # ======================================================================

    @gl.public.write
    def set_oracle_price(self, price_atto: u256) -> None:
        self._only_owner()
        price = int(price_atto)
        if price <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Price must be positive")
        self.oracle_price_atto = u256(price)
        self.oracle_updated_ts = u256(_now_ts())

    @gl.public.write
    def set_baseline_price(self, price_atto: u256) -> None:
        self._only_owner()
        price = int(price_atto)
        if price <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Price must be positive")
        self.baseline_price_atto = u256(price)

    # ======================================================================
    # DEMO SIMULATION SURFACE
    #
    # Owner-only. These methods move this contract's own reported telemetry
    # into an anomalous-looking state so the demo has a condition for
    # AutoShield to judge. They implement no attack, touch no external
    # contract, and (apart from the oracle price, which is a legitimate
    # protocol parameter) never mutate real accounting -- `conservation_check`
    # holds before and after every one of them.
    # ======================================================================

    @gl.public.write
    def simulate_oracle_move(self, magnitude_bps: u256, direction: str) -> None:
        self._only_owner()
        magnitude = int(magnitude_bps)
        if magnitude <= 0 or magnitude >= BPS_DENOMINATOR:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Magnitude out of range")
        if direction not in ("UP", "DOWN"):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Direction must be UP or DOWN")

        baseline = int(self.baseline_price_atto)
        delta = baseline * magnitude // BPS_DENOMINATOR
        self.oracle_price_atto = u256(
            baseline + delta if direction == "UP" else baseline - delta
        )
        self.oracle_updated_ts = u256(_now_ts())

    @gl.public.write
    def simulate_borrow_spike(self, window_volume_bps: u256) -> None:
        self._only_owner()
        self.sim_borrow_volume_bps = u256(int(window_volume_bps))

    @gl.public.write
    def simulate_liquidity_drain(self, drain_bps: u256) -> None:
        self._only_owner()
        drain = int(drain_bps)
        if drain > BPS_DENOMINATOR:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Drain out of range")
        self.sim_liquidity_drain_bps = u256(drain)

    @gl.public.write
    def simulate_tx_burst(
        self, tx_count: u256, unique_senders: u256, top_sender_share_bps: u256
    ) -> None:
        self._only_owner()
        share = int(top_sender_share_bps)
        if share > BPS_DENOMINATOR:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Share out of range")
        self.sim_tx_count = u256(int(tx_count))
        self.sim_unique_senders = u256(int(unique_senders))
        self.sim_top_sender_share_bps = u256(share)

    @gl.public.write
    def reset_simulation(self) -> None:
        self._only_owner()
        self.oracle_price_atto = self.baseline_price_atto
        self.oracle_updated_ts = u256(_now_ts())
        self.sim_borrow_volume_bps = u256(0)
        self.sim_liquidity_drain_bps = u256(0)
        self.sim_tx_count = u256(0)
        self.sim_unique_senders = u256(0)
        self.sim_top_sender_share_bps = u256(0)
