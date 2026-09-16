#!/usr/bin/env python
"""
Launch GenLayer Sim with one compatibility shim applied.

WHY THIS EXISTS. `genlayer-test` ships two different calldata
implementations, and they disagree about addresses:

  - the client side (`genlayer_py.abi.calldata`) decodes an address argument
    into `genlayer_py.types.CalldataAddress`;
  - the contract side (`genlayer.calldata`, the GenVM SDK) only knows
    `genlayer.types.Address`.

glsim decodes an incoming transaction with the first and then re-encodes the
arguments with the second, inside
`gltest.direct.loader._calldata_roundtrip_args`. Any `Address` argument
therefore dies at that boundary with:

    not calldata encodable addr#<hex>: CalldataAddress

That breaks every address argument through glsim — `AutoShield`'s constructor,
`set_initial_guard`, `set_reporter`, `get_position`. Reproduced against
glsim 0.29.2 and still present on 0.30.0rc2; it is a defect in the tooling, not in the contracts.

THE SHIM. Convert `CalldataAddress` to the SDK's `Address` immediately before
that single roundtrip. Nothing else is touched: the contracts are unmodified,
consensus, voting, rotation and storage are all glsim's own code, and the
conversion is value-preserving (the same 20 bytes).

Run `scripts/glsim.sh start` rather than calling this directly.
"""

import sys


def install_address_shim() -> bool:
    """Patch the one function where the two calldata types meet."""
    try:
        from gltest.direct import loader
        from genlayer_py.types import CalldataAddress
    except ImportError as exc:  # pragma: no cover - environment problem
        print(f"[glsim_node] shim unavailable: {exc}", file=sys.stderr)
        return False

    original = loader._calldata_roundtrip_args

    def convert(value):
        if isinstance(value, CalldataAddress):
            from genlayer.types import Address

            return Address(value.as_bytes)
        if isinstance(value, dict):
            return {key: convert(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            converted = [convert(item) for item in value]
            return type(value)(converted) if isinstance(value, tuple) else converted
        return value

    def patched(args, kwargs):
        return original(
            tuple(convert(arg) for arg in args),
            {key: convert(val) for key, val in kwargs.items()},
        )

    patched.__doc__ = original.__doc__
    loader._calldata_roundtrip_args = patched
    return True


def install_clock_shim() -> bool:
    """
    Make the node's clock control actually reach the contract clock.

    glsim exposes `sim_increaseTime` / `sim_setTime`, and implements them by
    calling `VMContext.warp()`. But gltest's `warp` only sets an internal field
    and then calls `_refresh_gl_message()`, which rewrites just
    `sender_address` and `origin_address` on `gl.message.raw`. It never touches
    `gl.message.raw['datetime']` -- the only clock a GenLayer contract can read,
    since GenVM exposes no block timestamp.

    The result is that time control silently does nothing: measured as a 0s
    contract-clock movement for a 10000s node increase. Without this shim, no
    deadline, freshness or expiry behaviour can be exercised through consensus
    at all.

    The shim writes the same value `warp` was already given, to the place the
    contract actually reads. It invents nothing and changes no contract.
    """
    try:
        from gltest.direct.vm import VMContext
    except ImportError as exc:  # pragma: no cover - environment problem
        print(f"[glsim_node] clock shim unavailable: {exc}", file=sys.stderr)
        return False

    original_warp = VMContext.warp

    def warp(self, timestamp: str) -> None:
        original_warp(self, timestamp)
        # GenVM v0.6: the raw message lives on `genlayer.message.raw`, and
        # the module also splats its keys into its own globals at import, so
        # the alias has to move with it.
        message = sys.modules.get("genlayer.message")
        if message is not None and getattr(message, "raw", None) is not None:
            message.raw["datetime"] = timestamp
            setattr(message, "datetime", timestamp)

    warp.__doc__ = original_warp.__doc__
    VMContext.warp = warp
    return True


def install_method_key_shim() -> bool:
    """
    Reconcile the two halves of glsim over the calldata method key.

    GenVM v0.6 moved the invoked method name in a calldata object from the key
    `"method"` to the EMPTY key. `genlayer-py 0.19.0rc2` (the client half) was
    updated -- `make_calldata_object` writes `ret[""] = method` -- but
    `glsim 0.30.0rc2` (the node half) still reads `cd.get("method")`, so every
    write and every view through the local node dies at

        ValueError: No method in calldata

    Reproduced against glsim 0.30.0rc2. It is a defect in the release
    candidate's own two halves disagreeing, not in the contracts: the same
    contracts and the same client run correctly against Studio Next, where the
    node half is the real consensus stack rather than this simulator.

    The same stale lookup appears on the cross-contract path, where the request
    dict arrives from the contract's own SDK rather than from the wire:
    `_handle_call_in_contract` and `_handle_post_in_contract` both read
    `calldata_obj.get('method')` and so invoke `None`, which surfaces in the
    node log as

        [cross-contract] 0x....None() -> ERROR: attribute name must be string

    THE SHIM. Surface the empty-key value under `"method"` as well, on both
    paths. It adds an alias for one string; it decodes nothing differently,
    changes no argument, and touches neither contract nor consensus.
    """
    try:
        from glsim import engine, server, tx_decoder
    except ImportError as exc:  # pragma: no cover - environment problem
        print(f"[glsim_node] method-key shim unavailable: {exc}", file=sys.stderr)
        return False

    original = tx_decoder.decode_calldata_bytes

    def patched(raw: bytes) -> dict:
        decoded = original(raw)
        if isinstance(decoded, dict) and not decoded.get("method") and decoded.get(""):
            decoded = {**decoded, "method": decoded[""]}
        return decoded

    patched.__doc__ = original.__doc__
    # Both modules bound the function by value at import time, so rebinding the
    # definition alone would leave their copies untouched.
    tx_decoder.decode_calldata_bytes = patched
    engine.decode_calldata_bytes = patched
    server.decode_calldata_bytes = patched

    def alias_in_request(handler):
        def wrapper(self, vm, data):
            calldata_obj = data.get("calldata") if isinstance(data, dict) else None
            if (
                isinstance(calldata_obj, dict)
                and not calldata_obj.get("method")
                and calldata_obj.get("")
            ):
                data = {**data, "calldata": {**calldata_obj, "method": calldata_obj[""]}}
            return handler(self, vm, data)

        wrapper.__doc__ = handler.__doc__
        return wrapper

    for name in ("_handle_call_in_contract", "_handle_post_in_contract"):
        setattr(
            engine.SimEngine, name, alias_in_request(getattr(engine.SimEngine, name))
        )
    return True


def install_llm_text_shim() -> bool:
    """
    Hand the nondet block the mock response as TEXT, as GenVM v0.6 does.

    `gltest.direct.wasi_mock._handle_llm_request` pre-parses a JSON-looking
    mock string into a dict before returning it, which was correct for v0.5.
    v0.6's `gl.nondet` decodes the `ok` payload as text and does its own
    `json.loads`, so a pre-parsed dict fails the block with

        invalid nondeterministic response: text result is not a string

    glsim installs the mocks from `sim_installMocks` through that very
    function, so the node needs the same correction the direct-mode harness
    applies (see workaround 4 in tests/direct/conftest.py). Returning the raw
    string is what the real executor does, so this makes the simulator MORE
    faithful to Studio, not less.
    """
    try:
        from gltest.direct import wasi_mock
    except ImportError as exc:  # pragma: no cover - environment problem
        print(f"[glsim_node] llm text shim unavailable: {exc}", file=sys.stderr)
        return False

    original = wasi_mock._handle_llm_request

    def patched(vm, data):
        response = vm._match_llm_mock(data.get("prompt", ""))
        if response is None:
            # Unmocked prompts still belong to gltest: strict mode, the live
            # LLM handler and the "no mock registered" error are all its own.
            return original(vm, data)
        return {"ok": response}

    patched.__doc__ = original.__doc__
    wasi_mock._handle_llm_request = patched
    return True


def main() -> int:
    if install_llm_text_shim():
        print("[glsim_node] LLM mock text-passthrough shim installed")
    if install_method_key_shim():
        print("[glsim_node] calldata method-key shim installed")
    if install_address_shim():
        print("[glsim_node] CalldataAddress -> Address shim installed")
    if install_clock_shim():
        print("[glsim_node] warp -> gl.message.raw['datetime'] clock shim installed")

    from glsim.__main__ import main as glsim_main

    return glsim_main() or 0


if __name__ == "__main__":
    raise SystemExit(main())
