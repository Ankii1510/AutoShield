/** Presentation helpers. Pure functions, no chain access. */

import type { ProtocolMode, ResponseLevel } from "@/lib/types";

const ONE_ATTO = 10n ** 18n;

/** atto-scale integer -> compact human number. Never uses floats for the split. */
export function formatAtto(value: bigint, fractionDigits = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / ONE_ATTO;
  const scale = 10n ** BigInt(fractionDigits);
  const frac = ((abs % ONE_ATTO) * scale) / ONE_ATTO;

  const wholeText = whole.toLocaleString("en-US");
  const fracText = fractionDigits > 0 ? `.${frac.toString().padStart(fractionDigits, "0")}` : "";
  return `${negative ? "-" : ""}${wholeText}${fracText}`;
}

/** atto -> "$1.2M" style, for headline TVL. */
export function formatAttoCompact(value: bigint): string {
  const whole = value / ONE_ATTO;
  const n = Number(whole);
  if (!Number.isFinite(n)) return `${whole.toString()}`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

/** Basis points -> percentage string. 4100 -> "41.00%" */
export function formatBps(bps: number, fractionDigits = 2): string {
  return `${(bps / 100).toFixed(fractionDigits)}%`;
}

export function formatSignedBps(bps: number): string {
  const sign = bps > 0 ? "+" : "";
  return `${sign}${formatBps(bps)}`;
}

/** Unix seconds -> HH:MM:SS in the viewer's locale. */
export function formatClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "--:--:--";
  return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour12: false });
}

export function formatDateTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts * 1000).toLocaleString("en-GB", { hour12: false });
}

/** Seconds -> "29m 41s" / "1h 02m". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

export function shortenAddress(address: string, size = 4): string {
  if (!address || address.length < 2 * size + 4) return address || "—";
  return `${address.slice(0, 2 + size)}…${address.slice(-size)}`;
}

export function shortenHash(hash: string): string {
  return shortenAddress(hash, 6);
}

/** Human explanation of each protocol mode — shown next to the state itself. */
export const MODE_MEANING: Record<ProtocolMode, string> = {
  NORMAL: "All operations permitted. Supply, borrow, withdraw and repay are open.",
  RESTRICTED:
    "New borrowing is blocked and withdrawals are capped. Supply and repayment stay open.",
  HALTED:
    "Supply, borrowing and withdrawals are blocked. Repayment stays open so borrowers can always reduce risk.",
};

export const LEVEL_MEANING: Record<ResponseLevel, string> = {
  SAFE: "Evidence does not indicate an active exploit. No action taken.",
  PROTECT: "Credible but not conclusive. Reversible mitigation applied.",
  HALT: "Strong, corroborated evidence of an exploit in progress.",
};

export const MODE_FOR_LEVEL: Record<ResponseLevel, ProtocolMode> = {
  SAFE: "NORMAL",
  PROTECT: "RESTRICTED",
  HALT: "HALTED",
};

/** Parse the compact metadata a reporter attached, safely. */
export function parseMetadata(json: string): Record<string, number> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
      else if (typeof value === "string" && /^\d+$/.test(value)) out[key] = Number(value);
    }
    return out;
  } catch {
    return {};
  }
}
