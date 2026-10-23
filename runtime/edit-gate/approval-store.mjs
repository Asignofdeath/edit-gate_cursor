import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APPROVAL_DIR = __dirname;
export const APPROVAL_FILE = path.join(APPROVAL_DIR, "approval.json");
export const PENDING_FILE = path.join(APPROVAL_DIR, "pending.json");
export const GHOST_NUDGE_FILE = path.join(APPROVAL_DIR, "ghost-nudge.json");
export const CONFIG_FILE = path.join(APPROVAL_DIR, "config.json");

export const PENDING_WAIT_MS = 30 * 60 * 1000;
export const APPROVAL_BACKUP_TTL_MS = 15 * 60 * 1000;
export const TTL_MS = PENDING_WAIT_MS;
export const POLL_MS = 1000;

const DEFAULT_CONFIG = {
  enabled: true,
  singleDeleteWindowMs: 10_000,
  singleDeleteBurstLimit: 6,
  singleDeleteMaxPerTurn: 10,
  batchDeleteMaxPaths: 100,
  batchDeleteAllowDirectories: false,
  requireWorkspaceBound: true,
  allowedRoots: [],
};

export function readGateConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...data,
      enabled: data?.enabled !== false,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function isGateEnabled() {
  return readGateConfig().enabled !== false;
}

export function writeGateConfig(patch = {}) {
  fs.mkdirSync(APPROVAL_DIR, { recursive: true });
  const merged = { ...readGateConfig(), ...patch, updated_at: Date.now() };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export function readApproval(now = Date.now()) {
  try {
    if (!fs.existsSync(APPROVAL_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(APPROVAL_FILE, "utf8"));
    if (!data?.approved || typeof data.expires_at !== "number") return null;
    if (data.expires_at <= now) return null;
    return data;
  } catch {
    return null;
  }
}

export function readPending() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return null;
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writePending({ reason, paths = [], kind = "edit", allowDirectories = false }) {
  fs.mkdirSync(APPROVAL_DIR, { recursive: true });
  const maxPaths = readGateConfig().batchDeleteMaxPaths || 100;
  const pending = {
    pending_id: crypto.randomUUID(),
    status: "pending",
    kind: kind === "batch_delete" ? "batch_delete" : "edit",
    reason: String(reason || "").slice(0, 2000),
    paths: Array.isArray(paths) ? paths.map(String).slice(0, maxPaths) : [],
    allowDirectories: Boolean(allowDirectories),
    created_at: Date.now(),
    resolved_at: null,
  };
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), "utf8");
  return pending;
}

export function resolvePending(status, pendingId) {
  const pending = readPending();
  if (!pending || pending.pending_id !== pendingId) throw new Error(`No matching pending: ${pendingId}`);
  if (pending.status !== "pending") return pending;
  const updated = { ...pending, status, resolved_at: Date.now() };
  fs.writeFileSync(PENDING_FILE, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

export function writeApprovalFromPending(pending) {
  fs.mkdirSync(APPROVAL_DIR, { recursive: true });
  const now = Date.now();
  const data = {
    approved: true,
    scope: "turn",
    // Edit grant only — does NOT authorize Delete / shell deletes.
    grant: "edit",
    token: crypto.randomUUID(),
    pending_id: pending.pending_id,
    reason: pending.reason,
    paths: pending.paths,
    approved_at: now,
    expires_at: now + APPROVAL_BACKUP_TTL_MS,
  };
  fs.writeFileSync(APPROVAL_FILE, JSON.stringify(data, null, 2), "utf8");
  return data;
}

export function clearPending() {
  try {
    fs.unlinkSync(PENDING_FILE);
  } catch {
    /* ignore */
  }
}

export function clearApproval() {
  try {
    fs.unlinkSync(APPROVAL_FILE);
  } catch {
    /* ignore */
  }
}

export function clearTurnGrant() {
  clearApproval();
  clearPending();
  try {
    fs.unlinkSync(path.join(APPROVAL_DIR, "delete-burst.json"));
  } catch {
    /* ignore */
  }
}

export function writeGhostNudge() {
  fs.mkdirSync(APPROVAL_DIR, { recursive: true });
  const data = { id: crypto.randomUUID(), at: Date.now() };
  fs.writeFileSync(GHOST_NUDGE_FILE, JSON.stringify(data, null, 2), "utf8");
  return data;
}

export function clearGhostNudge() {
  try {
    fs.unlinkSync(GHOST_NUDGE_FILE);
  } catch {
    /* ignore */
  }
}

export function formatRemaining(data) {
  if (data?.scope === "turn") {
    const sec = Math.max(0, Math.floor((data.expires_at - Date.now()) / 1000));
    return `until turn ends (backup ${Math.floor(sec / 60)}m ${sec % 60}s)`;
  }
  const sec = Math.max(0, Math.floor((data.expires_at - Date.now()) / 1000));
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
