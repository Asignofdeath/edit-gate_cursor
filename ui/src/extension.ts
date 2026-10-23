import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

interface PendingRequest {
  pending_id: string;
  status: "pending" | "approved" | "denied";
  kind?: "edit" | "batch_delete";
  reason: string;
  paths: string[];
  allowDirectories?: boolean;
  created_at: number;
  resolved_at: number | null;
}

interface ApprovalState {
  approved: boolean;
  expires_at: number;
  reason?: string;
  scope?: string;
}

let panel: vscode.WebviewPanel | undefined;
let statusItem: vscode.StatusBarItem;
let watcher: fs.FSWatcher | undefined;
let shownId: string | undefined;
let containInFlight = false;
let approvalExpiryTimer: ReturnType<typeof setTimeout> | undefined;

/** Global gate dir — same place MCP + user hooks read/write. */
function gateDir(): string {
  return path.join(os.homedir(), ".cursor", "edit-gate");
}

function pendingFile(): string {
  return path.join(gateDir(), "pending.json");
}

function approvalFile(): string {
  return path.join(gateDir(), "approval.json");
}

function configFile(): string {
  return path.join(gateDir(), "config.json");
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration("editGate").get<boolean>("enabled", true);
}

/** Sync VS Code setting → config.json so hooks can read the master switch (merge, don't wipe). */
function syncEnabledToDisk(): void {
  const enabled = isEnabled();
  fs.mkdirSync(gateDir(), { recursive: true });
  let prev: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configFile())) {
      prev = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Record<string, unknown>;
    }
  } catch {
    prev = {};
  }
  fs.writeFileSync(
    configFile(),
    JSON.stringify({ ...prev, enabled, updated_at: Date.now() }, null, 2),
    "utf8"
  );
}

function readPending(): PendingRequest | null {
  const file = pendingFile();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PendingRequest;
  } catch {
    return null;
  }
}

function readApproval(now = Date.now()): ApprovalState | null {
  const file = approvalFile();
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as ApprovalState;
    if (!data?.approved || typeof data.expires_at !== "number") return null;
    if (data.expires_at <= now) return null;
    return data;
  } catch {
    return null;
  }
}

function resolvePending(status: "approved" | "denied"): boolean {
  const file = pendingFile();
  const pending = readPending();
  if (!pending || pending.status !== "pending") return false;
  const updated: PendingRequest = { ...pending, status, resolved_at: Date.now() };
  fs.writeFileSync(file, JSON.stringify(updated, null, 2), "utf8");
  return true;
}

function scheduleApprovalExpiry(approval: ApprovalState): void {
  if (approvalExpiryTimer) {
    clearTimeout(approvalExpiryTimer);
    approvalExpiryTimer = undefined;
  }
  const ms = Math.max(0, approval.expires_at - Date.now()) + 50;
  approvalExpiryTimer = setTimeout(() => {
    approvalExpiryTimer = undefined;
    refreshStatusBar();
  }, Math.min(ms, 2147483647));
}

/**
 * Status bar colors:
 * - gate off: muted / off label
 * - prompt (pending Allow/Deny): yellow warning background
 * - approved: green text
 * - idle: no special color
 */
function refreshStatusBar(): void {
  if (!isEnabled()) {
    statusItem.text = "$(circle-slash) Edit Gate: off";
    statusItem.backgroundColor = undefined;
    statusItem.color = undefined;
    statusItem.tooltip = `Edit Gate disabled (Settings → editGate.enabled)\nHooks allow all edits while off.\n${gateDir()}`;
    return;
  }

  const pending = readPending();
  const approval = readApproval();

  if (pending?.status === "pending") {
    const batch = pending.kind === "batch_delete";
    statusItem.text = batch ? "$(trash) Edit Gate: 删除审批" : "$(bell) Edit Gate: waiting";
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusItem.color = undefined;
    statusItem.tooltip = batch
      ? `批量删除审批 — 点击打开面板\n${gateDir()}`
      : `Click to open Allow/Deny panel\n${gateDir()}`;
    return;
  }

  if (approval) {
    statusItem.text = "$(check) Edit Gate: 授权中";
    statusItem.backgroundColor = undefined;
    statusItem.color = new vscode.ThemeColor("charts.green");
    statusItem.tooltip = `Approved this turn\nClick: contain ghost (manual)\n${approval.reason || ""}\n${gateDir()}`;
    scheduleApprovalExpiry(approval);
    return;
  }

  statusItem.text = "$(shield) Edit Gate";
  statusItem.backgroundColor = undefined;
  statusItem.color = undefined;
  statusItem.tooltip = `Click: contain ghost (focus → send "." → Stop ~1s)\nWhen waiting for approval, click opens the panel.\n${gateDir()}`;
}

function htmlFor(p: PendingRequest): string {
  const batch = p.kind === "batch_delete";
  const count = p.paths?.length || 0;
  const pathItems = (p.paths || []).map((x) => {
    let exists = "";
    try {
      if (fs.existsSync(x)) {
        const st = fs.statSync(x);
        exists = st.isDirectory()
          ? ' <span class="warn">[DIR]</span>'
          : ' <span class="ok">[file]</span>';
      } else {
        exists = ' <span class="miss">[missing]</span>';
      }
    } catch {
      exists = "";
    }
    return `<li><code>${escapeHtml(x)}</code>${exists}</li>`;
  });
  const pathsHtml = pathItems.length
    ? pathItems.join("")
    : "<li><em>(not specified)</em></li>";
  const title = batch ? "Edit Gate — 批量删除审批" : "Edit Gate — approval required";
  const blurb = batch
    ? `将删除下列 <strong>${count}</strong> 项。请逐条核对路径。${
        p.allowDirectories ? " <span class=\"warn\">含目录递归删除</span>" : " 默认仅文件。"
      }`
    : "Agent wants to modify files (edit grant). Deletions require a separate batch-delete approval.";
  const allowLabel = batch ? `Allow 删除这 ${count} 项` : "Allow (this turn · edits only)";
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h2 { margin-top: 0; }
  .reason { white-space: pre-wrap; background: var(--vscode-textBlockQuote-background); padding: 12px; border-radius: 6px; }
  ul.paths { padding-left: 20px; max-height: 50vh; overflow: auto; }
  .row { display: flex; gap: 12px; margin-top: 20px; }
  button { flex: 1; padding: 10px 16px; font-size: 14px; cursor: pointer; border: none; border-radius: 4px; }
  .allow { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .deny { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-foreground); }
  .meta { opacity: 0.7; font-size: 12px; margin-top: 16px; }
  .warn { color: #c90; font-weight: 600; }
  .ok { opacity: 0.6; font-size: 11px; }
  .miss { opacity: 0.5; font-size: 11px; }
</style></head><body>
  <h2>${title}</h2>
  <p>${blurb}</p>
  <h3>Reason</h3>
  <div class="reason">${escapeHtml(p.reason)}</div>
  <h3>${batch ? `Paths (${count})` : "Paths"}</h3>
  <ul class="paths">${pathsHtml}</ul>
  <div class="row">
    <button class="allow" onclick="send('approve')">${allowLabel}</button>
    <button class="deny" onclick="send('deny')">Deny</button>
  </div>
  <p class="meta">Gate dir: ${escapeHtml(gateDir())}</p>
  <script>
    const vscode = acquireVsCodeApi();
    function send(cmd) { vscode.postMessage({ cmd }); }
  </script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function showPanel(p: PendingRequest): void {
  if (!isEnabled()) {
    vscode.window.showWarningMessage("Edit Gate 已关闭（editGate.enabled）。");
    return;
  }
  if (panel) {
    panel.reveal(vscode.ViewColumn.One, true);
    panel.webview.html = htmlFor(p);
    return;
  }
  panel = vscode.window.createWebviewPanel("editGate", "Edit Gate", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = htmlFor(p);
  panel.webview.onDidReceiveMessage((msg: { cmd?: string }) => {
    if (msg.cmd === "approve") {
      const kind = readPending()?.kind;
      if (resolvePending("approved")) {
        vscode.window.showInformationMessage(
          kind === "batch_delete"
            ? "Edit Gate: 已批准批量删除，MCP 将立即执行清单内路径。"
            : "Edit Gate: approved edits for this agent turn (not deletes)."
        );
        panel?.dispose();
        setTimeout(() => refreshStatusBar(), 400);
        refreshStatusBar();
      }
    } else if (msg.cmd === "deny") {
      if (resolvePending("denied")) {
        vscode.window.showWarningMessage("Edit Gate: denied.");
        panel?.dispose();
        refreshStatusBar();
      }
    }
  });
  panel.onDidDispose(() => {
    panel = undefined;
  });
}

function onPendingChanged(): void {
  if (!isEnabled()) {
    refreshStatusBar();
    if (panel) panel.dispose();
    return;
  }
  const p = readPending();
  if (!p || p.status !== "pending") {
    if (!p) shownId = undefined;
    refreshStatusBar();
    return;
  }
  refreshStatusBar();
  if (shownId === p.pending_id) return;
  shownId = p.pending_id;
  const msg =
    p.kind === "batch_delete"
      ? `Edit Gate: 批量删除 ${p.paths?.length || 0} 项，请确认路径。`
      : "Edit Gate: Agent requests permission to edit files.";
  vscode.window.showWarningMessage(msg, "Open panel").then((sel) => {
    if (sel === "Open panel") showPanel(p);
  });
  showPanel(p);
}

async function focusComposer(): Promise<boolean> {
  const candidates = [
    "composer.focusComposer",
    "composer.startComposerPrompt",
    "aichat.focusInput",
    "workbench.action.chat.open",
  ];
  for (const cmd of candidates) {
    try {
      await vscode.commands.executeCommand(cmd);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function sendPlaceholderAndCancel(): Promise<void> {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait('.')
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1000
[System.Windows.Forms.SendKeys]::SendWait('^+{BACKSPACE}')
`;
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { windowsHide: true, timeout: 15000 }
  );
}

async function runGhostContainment(): Promise<void> {
  if (!isEnabled()) {
    vscode.window.showWarningMessage("Edit Gate 已关闭（editGate.enabled）。");
    return;
  }
  if (containInFlight) return;
  containInFlight = true;
  try {
    const focused = await focusComposer();
    if (!focused) {
      vscode.window.showWarningMessage("Edit Gate: 未能聚焦聊天输入框。请先点击 Agent 输入框，再手动发送并 Cancel。");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
    await sendPlaceholderAndCancel();
    vscode.window.showInformationMessage("Edit Gate: 已尝试遏制幽灵（占位发送 + ~1s Stop）。实验功能，不保证防扣费。");
  } catch (err) {
    vscode.window.showErrorMessage(`Edit Gate: 遏制幽灵失败：${String(err)}`);
  } finally {
    containInFlight = false;
    refreshStatusBar();
  }
}

/** Status bar click: open approval panel if waiting; otherwise run contain-ghost. */
async function onStatusClick(): Promise<void> {
  if (!isEnabled()) {
    const turnOn = await vscode.window.showInformationMessage(
      "Edit Gate 已关闭。打开总开关？",
      "打开 editGate.enabled"
    );
    if (turnOn) {
      await vscode.workspace.getConfiguration("editGate").update("enabled", true, vscode.ConfigurationTarget.Global);
      syncEnabledToDisk();
      refreshStatusBar();
    }
    return;
  }
  const p = readPending();
  if (p?.status === "pending") {
    showPanel(p);
    return;
  }
  await runGhostContainment();
}

function startWatch(): void {
  const dir = gateDir();
  fs.mkdirSync(dir, { recursive: true });
  try { watcher?.close(); } catch {}
  watcher = fs.watch(dir, { persistent: true }, (_event, filename) => {
    const name = filename ? String(filename) : "";
    if (!name || name.includes("pending")) onPendingChanged();
    if (!name || name.includes("approval") || name.includes("config")) refreshStatusBar();
  });
  onPendingChanged();
  refreshStatusBar();
}

export function activate(context: vscode.ExtensionContext): void {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "editGate.statusClick";
  syncEnabledToDisk();
  refreshStatusBar();
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("editGate.statusClick", () => onStatusClick()),
    vscode.commands.registerCommand("editGate.showPanel", () => {
      if (!isEnabled()) {
        vscode.window.showWarningMessage("Edit Gate 已关闭（editGate.enabled）。");
        return;
      }
      const p = readPending();
      if (p?.status === "pending") showPanel(p);
      else vscode.window.showInformationMessage(p ? `No pending request (status: ${p.status}).` : `No pending edit request.\nWatching: ${gateDir()}`);
    }),
    vscode.commands.registerCommand("editGate.approve", () => {
      if (!isEnabled()) return;
      if (resolvePending("approved")) vscode.window.showInformationMessage("Edit Gate: approved.");
      else vscode.window.showWarningMessage("Nothing to approve.");
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("editGate.deny", () => {
      if (!isEnabled()) return;
      if (resolvePending("denied")) vscode.window.showWarningMessage("Edit Gate: denied.");
      else vscode.window.showWarningMessage("Nothing to deny.");
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("editGate.containGhost", () => runGhostContainment()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("editGate.enabled")) {
        syncEnabledToDisk();
        if (!isEnabled() && panel) panel.dispose();
        refreshStatusBar();
      }
    })
  );

  startWatch();
}

export function deactivate(): void {
  if (approvalExpiryTimer) clearTimeout(approvalExpiryTimer);
  try { watcher?.close(); } catch {}
  panel?.dispose();
}
