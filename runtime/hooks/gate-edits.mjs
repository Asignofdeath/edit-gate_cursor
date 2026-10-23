#!/usr/bin/env node
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const gateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "edit-gate");
const storeUrl = pathToFileURL(path.join(gateDir, "approval-store.mjs")).href;
const policyUrl = pathToFileURL(path.join(gateDir, "delete-policy.mjs")).href;
const burstUrl = pathToFileURL(path.join(gateDir, "delete-burst.mjs")).href;

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function extractCommand(input) {
  const ti = input?.tool_input;
  if (ti && typeof ti === "object" && ti.command) return String(ti.command);
  if (input.command) return String(input.command);
  return "";
}

function extractTargetPath(input) {
  const ti = input?.tool_input;
  if (!ti || typeof ti !== "object") return extractCommand(input).slice(0, 200);
  return String(ti.path || ti.file_path || ti.target_notebook || ti.command || "");
}

function isDeleteTool(input) {
  const n = String(input.tool_name || input.toolName || input.tool || "").trim();
  return n === "Delete";
}

function fuseDeny(burst) {
  const why =
    burst.reason === "window_burst"
      ? `${burst.windowMs / 1000}s 内单删超过 ${burst.burstLimit} 次`
      : burst.reason === "turn_max"
        ? `本轮单删超过 ${burst.maxPerTurn} 次`
        : "本轮单删已熔断";
  return {
    permission: "deny",
    user_message: `已熔断（${why}）。本轮内禁止 Shell 单删与 Delete 工具；请用 edit-gate → request_batch_delete。`,
    agent_message: `Single-delete circuit open (${burst.reason || "fused"}; turn=${burst.turnCount}, window=${burst.windowCount}/${burst.burstLimit}). Call request_batch_delete. Do not retry Delete or shell single-file delete this turn.`,
  };
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", async () => {
  let input = {};
  try {
    if (raw.trim()) input = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    out({
      permission: "ask",
      user_message: "Edit Gate: 无法解析 hook 输入。",
      agent_message: "gate-edits: invalid JSON stdin",
    });
    return;
  }

  try {
    const { isGateEnabled, readApproval } = await import(storeUrl);
    const { isBatchOrRecursiveDelete, isSingleFileShellDelete, BATCH_DELETE_DENY } = await import(policyUrl);
    const { isDeleteFused, recordSingleDelete } = await import(burstUrl);

    const command = extractCommand(input);
    const target = extractTargetPath(input);
    const deleteTool = isDeleteTool(input);
    const singleShell = Boolean(command && isSingleFileShellDelete(command));
    const isSingleDelete = deleteTool || singleShell;

    // 1) Shell batch/recursive — always deny.
    if (command && isBatchOrRecursiveDelete(command)) {
      out(BATCH_DELETE_DENY);
      return;
    }

    // 2) Single-delete (Delete tool OR shell single-file): dual fuse, else need edit approval then allow.
    if (isSingleDelete) {
      if (isDeleteFused()) {
        out(fuseDeny({ reason: "already_fused", turnCount: 0, windowCount: 0, burstLimit: 6, maxPerTurn: 10, windowMs: 10000 }));
        return;
      }

      const gateOn = isGateEnabled();
      if (gateOn && !readApproval()) {
        out({
          permission: "deny",
          user_message:
            "单删前需先获得编辑批准。请先 request_edit_approval；批量删请用 request_batch_delete。",
          agent_message: target
            ? `Blocked single-delete (${String(target).slice(0, 200)}). Call request_edit_approval first (or request_batch_delete for many files).`
            : "Blocked single-delete. Call request_edit_approval first (or request_batch_delete for many files).",
        });
        return;
      }

      // Gate off: still enforce fuse accounting for safety.
      const burst = recordSingleDelete(target);
      if (!burst.ok) {
        out(fuseDeny(burst));
        return;
      }
      out({ permission: "allow" });
      return;
    }

    if (!isGateEnabled()) {
      out({ permission: "allow" });
      return;
    }

    // 3) Edits / non-delete shell — turn edit grant.
    if (readApproval()) {
      out({ permission: "allow" });
      return;
    }

    out({
      permission: "deny",
      user_message:
        "Edits/Shell blocked. Call MCP request_edit_approval and click Allow. Batch deletes: request_batch_delete.",
      agent_message: target
        ? `Blocked (${String(target).slice(0, 200)}). Edits: request_edit_approval. Batch deletes: request_batch_delete.`
        : "Blocked. Edits: request_edit_approval. Batch deletes: request_batch_delete.",
    });
  } catch (err) {
    out({
      permission: "deny",
      user_message: "Edit gate hook error.",
      agent_message: String(err),
    });
  }
});
