/**
 * Shell batch/recursive/wildcard delete detection for Edit Gate hooks.
 */

export function normalizeCmd(cmd) {
  return String(cmd || "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

function isRecursiveOrBatchFlag(c) {
  return (
    /-Recurse\b/i.test(c) ||
    /\/s(?:\s|$|\/)/i.test(c) ||
    /-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b/.test(c) ||
    /(?:^|\s)-r(?:\s|$)/.test(c) ||
    /(?:^|\s)--recursive(?:\s|$)/.test(c) ||
    /(?:^|\s)-rf(?:\s|$)|(?:^|\s)-fr(?:\s|$)/.test(c)
  );
}

function isDeleteVerb(c) {
  return (
    /\bRemove-Item\b/i.test(c) ||
    /\bri\b/i.test(c) ||
    /\brm\b/.test(c) ||
    /\bdel\b/i.test(c) ||
    /\berase\b/i.test(c) ||
    /\b(?:rd|rmdir)\b/i.test(c) ||
    /\brimraf\b/i.test(c) ||
    (/\bunlink\b/i.test(c) && (/\s-r\b|\s--recursive\b/i.test(c)))
  );
}

function hasWildcardTarget(c) {
  if (/(?:^|[\s"'=])\*(?:[\s"']|$)/.test(c)) return true;
  if (/[A-Za-z]:[^;\n]*\*/.test(c)) return true;
  if (/-(?:Include|Exclude|Filter)\s+[^\s]*\*/i.test(c)) return true;
  if (/\*\.(?:js|ts|tsx|jsx|py|json|log|tmp|dist|o|obj)\b/i.test(c) && isDeleteVerb(c)) return true;
  return false;
}

function isPipelineBatchDelete(c) {
  if (/Get-ChildItem/i.test(c) && /\|/.test(c) && /Remove-Item|\brm\b|\bdel\b/i.test(c)) return true;
  if (/gci\b/i.test(c) && /\|/.test(c) && /Remove-Item|\brm\b|\bdel\b/i.test(c)) return true;
  if (/dir\b/i.test(c) && /\|/.test(c) && /Remove-Item/i.test(c)) return true;
  if (/\bfind\b/.test(c) && /-delete\b/.test(c)) return true;
  if (/\bfind\b/.test(c) && /-exec\b/.test(c) && /\brm\b/.test(c)) return true;
  if (/\bxargs\b/.test(c) && /\brm\b/.test(c)) return true;
  if (/ForEach-Object/i.test(c) && /Remove-Item/i.test(c)) return true;
  if (/%\s*\{[^}]*Remove-Item/i.test(c)) return true;
  return false;
}

function isDiskDestroy(c) {
  if (/\bformat\b/i.test(c) && /[A-Za-z]:/.test(c)) return true;
  if (/\bdiskpart\b/i.test(c)) return true;
  if (/\bClear-Disk\b|\bRemove-Partition\b|\bInitialize-Disk\b/i.test(c)) return true;
  if (/\bClear-RecycleBin\b/i.test(c)) return true;
  return false;
}

/** True if shell command is batch/recursive/wildcard delete or disk wipe. Always deny. */
export function isBatchOrRecursiveDelete(cmd) {
  const c = normalizeCmd(cmd);
  if (!c) return false;

  if (isDiskDestroy(c)) return true;
  if (isPipelineBatchDelete(c)) return true;
  if (/\brimraf\b/i.test(c)) return true;
  if (/\b(?:rd|rmdir)\b/i.test(c) && /\/s/i.test(c)) return true;
  if (/\bdel\b/i.test(c) && /\/s/i.test(c)) return true;
  if (/\berase\b/i.test(c) && /\/s/i.test(c)) return true;
  if (/\brm\b/.test(c) && (isRecursiveOrBatchFlag(c) || hasWildcardTarget(c))) return true;
  if (/\bRemove-Item\b/i.test(c) && (isRecursiveOrBatchFlag(c) || hasWildcardTarget(c))) return true;
  if (/\bdel\b/i.test(c) && (hasWildcardTarget(c) || (/\/q/i.test(c) && /\*/.test(c)))) return true;
  if (/(?:^|[|&;]\s*)ri\b/i.test(c) && (isRecursiveOrBatchFlag(c) || hasWildcardTarget(c))) return true;
  if (/\brobocopy\b/i.test(c) && /\/(?:mir|purge)\b/i.test(c)) return true;
  return false;
}

/** Single-file shell delete (not batch). Used to force batch_delete channel. */
export function isSingleFileShellDelete(cmd) {
  const c = normalizeCmd(cmd);
  if (!c || isBatchOrRecursiveDelete(c)) return false;
  if (/\bRemove-Item\b/i.test(c)) return true;
  if (/(?:^|[|&;]\s*)ri\b/i.test(c) && !/\bri\w/i.test(c)) return true;
  if (/\brm\b/.test(c) && !isRecursiveOrBatchFlag(c) && !hasWildcardTarget(c)) return true;
  if (/\bdel\b/i.test(c) && !/\/s/i.test(c) && !hasWildcardTarget(c)) return true;
  if (/\berase\b/i.test(c) && !/\/s/i.test(c)) return true;
  if (/\b(?:rd|rmdir)\b/i.test(c) && !/\/s/i.test(c)) return true;
  return false;
}

export const BATCH_DELETE_DENY = {
  permission: "deny",
  user_message:
    "已拦截：禁止通过 Shell 做批量/递归/通配删除。请让 Agent 调用 edit-gate → request_batch_delete（面板列出全部路径后再删）。",
  agent_message:
    "Blocked: shell batch/recursive deletes are forbidden. Call MCP edit-gate request_batch_delete with a full absolute path list; do not retry shell deletes.",
};

/** @deprecated kept for imports; single deletes are allowed until fuse. */
export const SINGLE_DELETE_DENY = {
  permission: "deny",
  user_message: "单删已熔断。请使用 edit-gate → request_batch_delete。",
  agent_message:
    "Single-delete circuit open. Call MCP edit-gate request_batch_delete with the full path list.",
};
