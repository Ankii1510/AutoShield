#!/usr/bin/env bash
# Start / stop the local GenLayer Sim node used by tests/integration.
#
#   scripts/glsim.sh restart [validators]  # default 5 -- use this before a test run
#   scripts/glsim.sh start [validators]
#   scripts/glsim.sh stop
#   scripts/glsim.sh status
#
# IMPORTANT: start a FRESH node for each test session. glsim runs every contract
# in one Python process, and the GenLayer SDK allows only one Contract subclass
# per process, so deploying the same contract code twice into the same node
# fails with "class is not marked for usage within storage". `restart` is the
# safe default.
#
# GLSim is a lightweight local GenLayer network: one leader plus N validators,
# real consensus voting, leader rotation on disagreement. It needs no Docker.
#
# Optional live-LLM mode (see docs/ARCHITECTURE.md "Consensus Verification"):
#   export AUTOSHIELD_LLM_PROVIDER=openai:gpt-4o-mini
#   export OPENAI_API_KEY=...        # or ANTHROPIC_API_KEY for anthropic:*
# Without those, tests install deterministic evaluator responses over the
# supported `sim_installMocks` RPC and no key is required.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/.glsim.pid"
LOG_FILE="$ROOT/.glsim.log"
PORT="${GLSIM_PORT:-4000}"
PY_BIN="$ROOT/.venv/bin/python"
NODE="$ROOT/scripts/glsim_node.py"

start() {
  local validators="${1:-5}"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "glsim already running (pid $(cat "$PID_FILE")) on port $PORT"
    return 0
  fi
  if [ ! -x "$PY_BIN" ]; then
    echo "venv python not found at $PY_BIN" >&2
    return 1
  fi

  # Chain id must match genlayer-py's built-in `localnet` definition (61999),
  # not glsim's own default of 61127 — several client calls compare the two and
  # silently fall back when they differ.
  local args=(--port "$PORT" --validators "$validators" --seed 42 --no-browser
              --chain-id "${GLSIM_CHAIN_ID:-61999}")
  if [ -n "${AUTOSHIELD_LLM_PROVIDER:-}" ]; then
    args+=(--llm-provider "$AUTOSHIELD_LLM_PROVIDER")
    echo "starting glsim with live LLM provider: $AUTOSHIELD_LLM_PROVIDER"
  fi

  setsid nohup "$PY_BIN" "$NODE" "${args[@]}" > "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"

  for _ in $(seq 1 40); do
    if curl -sS -m 2 -X POST "http://127.0.0.1:$PORT/api" \
         -H 'Content-Type: application/json' \
         -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' >/dev/null 2>&1; then
      echo "glsim up on port $PORT with $validators validators (pid $(cat "$PID_FILE"))"
      return 0
    fi
    sleep 0.5
  done

  echo "glsim failed to start; see $LOG_FILE" >&2
  tail -20 "$LOG_FILE" >&2 || true
  return 1
}

stop() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "glsim stopped"
  else
    echo "no pid file; nothing to stop"
  fi
}

status() {
  if curl -sS -m 2 -X POST "http://127.0.0.1:$PORT/api" \
       -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null; then
    echo " <- glsim reachable on port $PORT"
  else
    echo "glsim not reachable on port $PORT"
    return 1
  fi
}

case "${1:-}" in
  start)   start "${2:-5}" ;;
  restart) stop >/dev/null 2>&1 || true; sleep 1; start "${2:-5}" ;;
  stop)    stop ;;
  status)  status ;;
  *) echo "usage: $0 {restart [validators]|start [validators]|stop|status}" >&2; exit 2 ;;
esac
