#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  POLL_MS,
  PENDING_WAIT_MS,
  clearPending,
  formatRemaining,
  readApproval,
  readGateConfig,
  readPending,
  sleep,
  writeApprovalFromPending,
  writePending,
} from "./approval-store.mjs";

const server = new Server({ name: "edit-gate", version: "0.4.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "request_edit_approval",
      description:
        "BLOCKS until user clicks Allow/Deny. Grants EDIT rights for this agent turn only (Write/StrReplace/EditNotebook/non-delete Shell). Does NOT authorize deletes. For deletions use request_batch_delete.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
        },
        required: ["reason"],
      },
    },
    {
      name: "request_batch_delete",
      description:
        "SAFE batch delete channel. BLOCKS until user approves a panel listing EVERY absolute file path. On Allow, this server deletes only those paths (files by default). Do NOT use Shell rm/Remove-Item or the Delete tool for batch deletes.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why these files must be deleted" },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to delete (no globs). Prepare the full list first.",
          },
          allowDirectories: {
            type: "boolean",
            description: "If true, allow deleting directories recursively. Default false (files only).",
          },
        },
        required: ["reason", "paths"],
      },
    },
    {
      name: "check_edit_approval",
      description: "Read-only edit-approval status (not delete).",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

async function waitForUserDecision(pendingId) {
  const deadline = Date.now() + PENDING_WAIT_MS;
  while (Date.now() < deadline) {
    const current = readPending();
    if (current?.pending_id === pendingId) {
      if (current.status === "approved") return { ok: true, pending: current };
      if (current.status === "denied") return { ok: false, denied: true };
    }
    await sleep(POLL_MS);
  }
  return { ok: false, timeout: true };
}

function isDriveRoot(p) {
  return /^[A-Za-z]:[\\/]?$/.test(p);
}

function isUserProfileRoot(p) {
  const home = (process.env.USERPROFILE || process.env.HOME || "").replace(/\//g, "\\");
  if (!home) return false;
  const n = p.replace(/\//g, "\\").replace(/\\+$/, "");
  const h = home.replace(/\\+$/, "");
  return n.toLowerCase() === h.toLowerCase();
}

function normalizeDeletePaths(rawPaths, { allowDirectories, maxPaths, requireWorkspaceBound, allowedRoots }) {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    return { error: "paths must be a non-empty array of absolute paths" };
  }
  if (rawPaths.length > maxPaths) {
    return { error: `too many paths (${rawPaths.length}); max is ${maxPaths}` };
  }

  const normalized = [];
  const seen = new Set();

  for (const raw of rawPaths) {
    const s = String(raw || "").trim();
    if (!s) return { error: "empty path entry" };
    if (/[*?]/.test(s) || s.includes("...")) {
      return { error: `globs/wildcards not allowed: ${s}` };
    }
    if (!path.isAbsolute(s) && !/^[A-Za-z]:[\\/]/.test(s)) {
      return { error: `path must be absolute: ${s}` };
    }
    const resolved = path.resolve(s);
    const normKey = resolved.toLowerCase();
    if (seen.has(normKey)) continue;
    seen.add(normKey);

    if (isDriveRoot(resolved) || isDriveRoot(s)) {
      return { error: `refusing drive root: ${resolved}` };
    }
    if (isUserProfileRoot(resolved)) {
      return { error: `refusing user profile root: ${resolved}` };
    }

    if (requireWorkspaceBound) {
      const roots = Array.isArray(allowedRoots)
        ? allowedRoots.map((r) => path.resolve(String(r)))
        : [];
      if (roots.length > 0) {
        const ok = roots.some((root) => {
          const rel = path.relative(root, resolved);
          return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
        });
        if (!ok) return { error: `path outside allowedRoots: ${resolved}` };
      }
    }

    let st = null;
    try {
      st = fs.lstatSync(resolved);
    } catch {
      // missing files are ok — report as skipped at exec time
    }
    if (st?.isDirectory() && !allowDirectories) {
      return {
        error: `directory not allowed (set allowDirectories true to recursively delete): ${resolved}`,
      };
    }
    if (st?.isSymbolicLink?.()) {
      return { error: `refusing symlink: ${resolved}` };
    }

    normalized.push(resolved);
  }

  if (!normalized.length) return { error: "no paths left after normalization" };
  return { paths: normalized };
}

function executeDeletes(paths, allowDirectories) {
  const deleted = [];
  const failed = [];
  const skipped = [];

  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) {
        skipped.push({ path: p, reason: "not_found" });
        continue;
      }
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        failed.push({ path: p, reason: "symlink" });
        continue;
      }
      if (st.isDirectory()) {
        if (!allowDirectories) {
          failed.push({ path: p, reason: "directory_not_allowed" });
          continue;
        }
        fs.rmSync(p, { recursive: true, force: false });
      } else {
        fs.unlinkSync(p);
      }
      deleted.push(p);
    } catch (err) {
      failed.push({ path: p, reason: String(err?.message || err) });
    }
  }

  return { deleted, failed, skipped };
}

function jsonResult(obj, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "request_edit_approval") {
    const reason = args?.reason;
    if (!reason || typeof reason !== "string") {
      return jsonResult({ approved: false, error: "reason required" }, true);
    }
    const paths = Array.isArray(args?.paths) ? args.paths : [];
    const pending = writePending({ reason, paths, kind: "edit" });
    const decision = await waitForUserDecision(pending.pending_id);
    if (decision.ok) {
      const approval = writeApprovalFromPending(decision.pending);
      clearPending();
      return jsonResult({
        approved: true,
        scope: approval.scope || "turn",
        grant: "edit",
        token: approval.token,
        reason: approval.reason,
        paths: approval.paths,
        expires_at: approval.expires_at,
        remaining: formatRemaining(approval),
        note: "Edit grant only for this turn. Deletions require request_batch_delete.",
      });
    }
    clearPending();
    if (decision.denied) return jsonResult({ approved: false, status: "denied" }, true);
    return jsonResult(
      { approved: false, status: "timeout", message: "Enable Edit Gate UI and click Allow." },
      true
    );
  }

  if (name === "request_batch_delete") {
    const reason = args?.reason;
    if (!reason || typeof reason !== "string") {
      return jsonResult({ deleted: [], error: "reason required" }, true);
    }
    const cfg = readGateConfig();
    const allowDirs = args?.allowDirectories === true;

    const checked = normalizeDeletePaths(args?.paths, {
      allowDirectories: allowDirs,
      maxPaths: cfg.batchDeleteMaxPaths || 100,
      requireWorkspaceBound: cfg.requireWorkspaceBound !== false,
      allowedRoots: cfg.allowedRoots || [],
    });
    if (checked.error) {
      return jsonResult({ deleted: [], error: checked.error }, true);
    }

    const pending = writePending({
      reason: `[BATCH DELETE] ${reason}`,
      paths: checked.paths,
      kind: "batch_delete",
      allowDirectories: allowDirs,
    });

    const decision = await waitForUserDecision(pending.pending_id);
    if (!decision.ok) {
      clearPending();
      if (decision.denied) return jsonResult({ deleted: [], status: "denied" }, true);
      return jsonResult(
        { deleted: [], status: "timeout", message: "Enable Edit Gate UI and click Allow 删除." },
        true
      );
    }

    const approvedPaths = Array.isArray(decision.pending?.paths) ? decision.pending.paths : checked.paths;
    const allowDirsFinal = decision.pending?.allowDirectories === true;
    const result = executeDeletes(approvedPaths, allowDirsFinal);
    clearPending();
    return jsonResult({
      status: "completed",
      reason,
      allowDirectories: allowDirsFinal,
      ...result,
      note: "Only listed paths were targeted. Edit turn grant was NOT issued.",
    });
  }

  if (name === "check_edit_approval") {
    const approval = readApproval();
    return jsonResult(
      approval
        ? {
            approved: true,
            grant: approval.grant || "edit",
            reason: approval.reason,
            paths: approval.paths,
            remaining: formatRemaining(approval),
          }
        : { approved: false }
    );
  }

  return jsonResult({ error: `Unknown tool: ${name}` }, true);
});

await server.connect(new StdioServerTransport());
