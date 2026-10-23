import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readGateConfig } from "./approval-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BURST_FILE = path.join(__dirname, "delete-burst.json");

function limits() {
  const cfg = readGateConfig();
  const windowMs = Number(cfg.singleDeleteWindowMs);
  const burstLimit = Number(cfg.singleDeleteBurstLimit);
  const maxPerTurn = Number(cfg.singleDeleteMaxPerTurn);
  return {
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 10_000,
    burstLimit: Number.isFinite(burstLimit) && burstLimit > 0 ? burstLimit : 6,
    maxPerTurn: Number.isFinite(maxPerTurn) && maxPerTurn > 0 ? maxPerTurn : 10,
  };
}

export function readBurst() {
  try {
    if (!fs.existsSync(BURST_FILE)) {
      return { timestamps: [], turnCount: 0, fused: false, paths: [], updated_at: 0 };
    }
    return JSON.parse(fs.readFileSync(BURST_FILE, "utf8"));
  } catch {
    return { timestamps: [], turnCount: 0, fused: false, paths: [], updated_at: 0 };
  }
}

function writeBurst(data) {
  fs.mkdirSync(__dirname, { recursive: true });
  fs.writeFileSync(BURST_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function clearDeleteBurst() {
  try {
    fs.unlinkSync(BURST_FILE);
  } catch {
    /* ignore */
  }
}

export function isDeleteFused() {
  return Boolean(readBurst().fused);
}

/**
 * Record one allowed single-delete (Cursor Delete or shell single-file).
 * Dual tripwire: sliding window burst OR per-turn max → fuse for rest of turn.
 *
 * @returns {{ ok: boolean, fused: boolean, reason?: string, turnCount: number, windowCount: number, burstLimit: number, maxPerTurn: number, windowMs: number }}
 */
export function recordSingleDelete(targetPath = "") {
  const { windowMs, burstLimit, maxPerTurn } = limits();
  const prev = readBurst();
  const now = Date.now();

  if (prev.fused) {
    return {
      ok: false,
      fused: true,
      reason: "already_fused",
      turnCount: prev.turnCount || 0,
      windowCount: 0,
      burstLimit,
      maxPerTurn,
      windowMs,
    };
  }

  let timestamps = Array.isArray(prev.timestamps) ? prev.timestamps.filter((t) => now - t <= windowMs) : [];
  timestamps.push(now);
  const turnCount = (prev.turnCount || 0) + 1;
  const paths = Array.isArray(prev.paths) ? prev.paths.slice(0, 40) : [];
  if (targetPath) paths.push(String(targetPath).slice(0, 300));

  const windowCount = timestamps.length;
  let fused = false;
  let reason;

  // 超过 N：windowCount > burstLimit；本轮超过 max：turnCount > maxPerTurn
  if (windowCount > burstLimit) {
    fused = true;
    reason = "window_burst";
  } else if (turnCount > maxPerTurn) {
    fused = true;
    reason = "turn_max";
  }

  writeBurst({
    timestamps,
    turnCount,
    fused,
    fuseReason: reason || null,
    paths,
    updated_at: now,
    windowMs,
    burstLimit,
    maxPerTurn,
  });

  return {
    ok: !fused,
    fused,
    reason,
    turnCount,
    windowCount,
    burstLimit,
    maxPerTurn,
    windowMs,
  };
}
