"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var import_child_process = require("child_process");
var import_util = require("util");
var execFileAsync = (0, import_util.promisify)(import_child_process.execFile);
var panel;
var statusItem;
var watcher;
var shownId;
var containInFlight = false;
var approvalExpiryTimer;
function gateDir() {
  return path.join(os.homedir(), ".cursor", "edit-gate");
}
function pendingFile() {
  return path.join(gateDir(), "pending.json");
}
function approvalFile() {
  return path.join(gateDir(), "approval.json");
}
function configFile() {
  return path.join(gateDir(), "config.json");
}
function isEnabled() {
  return vscode.workspace.getConfiguration("editGate").get("enabled", true);
}
function syncEnabledToDisk() {
  const enabled = isEnabled();
  fs.mkdirSync(gateDir(), { recursive: true });
  let prev = {};
  try {
    if (fs.existsSync(configFile())) {
      prev = JSON.parse(fs.readFileSync(configFile(), "utf8"));
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
function readPending() {
  const file = pendingFile();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function readApproval(now = Date.now()) {
  const file = approvalFile();
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data?.approved || typeof data.expires_at !== "number") return null;
    if (data.expires_at <= now) return null;
    return data;
  } catch {
    return null;
  }
}
function resolvePending(status) {
  const file = pendingFile();
  const pending = readPending();
  if (!pending || pending.status !== "pending") return false;
  const updated = { ...pending, status, resolved_at: Date.now() };
  fs.writeFileSync(file, JSON.stringify(updated, null, 2), "utf8");
  return true;
}
function scheduleApprovalExpiry(approval) {
  if (approvalExpiryTimer) {
    clearTimeout(approvalExpiryTimer);
    approvalExpiryTimer = void 0;
  }
  const ms = Math.max(0, approval.expires_at - Date.now()) + 50;
  approvalExpiryTimer = setTimeout(() => {
    approvalExpiryTimer = void 0;
    refreshStatusBar();
  }, Math.min(ms, 2147483647));
}
function refreshStatusBar() {
  if (!isEnabled()) {
    statusItem.text = "$(circle-slash) Edit Gate: off";
    statusItem.backgroundColor = void 0;
    statusItem.color = void 0;
    statusItem.tooltip = `Edit Gate disabled (Settings \u2192 editGate.enabled)
Hooks allow all edits while off.
${gateDir()}`;
    return;
  }
  const pending = readPending();
  const approval = readApproval();
  if (pending?.status === "pending") {
    const batch = pending.kind === "batch_delete";
    statusItem.text = batch ? "$(trash) Edit Gate: \u5220\u9664\u5BA1\u6279" : "$(bell) Edit Gate: waiting";
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusItem.color = void 0;
    statusItem.tooltip = batch ? `\u6279\u91CF\u5220\u9664\u5BA1\u6279 \u2014 \u70B9\u51FB\u6253\u5F00\u9762\u677F
${gateDir()}` : `Click to open Allow/Deny panel
${gateDir()}`;
    return;
  }
  if (approval) {
    statusItem.text = "$(check) Edit Gate: \u6388\u6743\u4E2D";
    statusItem.backgroundColor = void 0;
    statusItem.color = new vscode.ThemeColor("charts.green");
    statusItem.tooltip = `Approved this turn
Click: contain ghost (manual)
${approval.reason || ""}
${gateDir()}`;
    scheduleApprovalExpiry(approval);
    return;
  }
  statusItem.text = "$(shield) Edit Gate";
  statusItem.backgroundColor = void 0;
  statusItem.color = void 0;
  statusItem.tooltip = `Click: contain ghost (focus \u2192 send "." \u2192 Stop ~1s)
When waiting for approval, click opens the panel.
${gateDir()}`;
}
function htmlFor(p) {
  const batch = p.kind === "batch_delete";
  const count = p.paths?.length || 0;
  const pathItems = (p.paths || []).map((x) => {
    let exists = "";
    try {
      if (fs.existsSync(x)) {
        const st = fs.statSync(x);
        exists = st.isDirectory() ? ' <span class="warn">[DIR]</span>' : ' <span class="ok">[file]</span>';
      } else {
        exists = ' <span class="miss">[missing]</span>';
      }
    } catch {
      exists = "";
    }
    return `<li><code>${escapeHtml(x)}</code>${exists}</li>`;
  });
  const pathsHtml = pathItems.length ? pathItems.join("") : "<li><em>(not specified)</em></li>";
  const title = batch ? "Edit Gate \u2014 \u6279\u91CF\u5220\u9664\u5BA1\u6279" : "Edit Gate \u2014 approval required";
  const blurb = batch ? `\u5C06\u5220\u9664\u4E0B\u5217 <strong>${count}</strong> \u9879\u3002\u8BF7\u9010\u6761\u6838\u5BF9\u8DEF\u5F84\u3002${p.allowDirectories ? ' <span class="warn">\u542B\u76EE\u5F55\u9012\u5F52\u5220\u9664</span>' : " \u9ED8\u8BA4\u4EC5\u6587\u4EF6\u3002"}` : "Agent wants to modify files (edit grant). Deletions require a separate batch-delete approval.";
  const allowLabel = batch ? `Allow \u5220\u9664\u8FD9 ${count} \u9879` : "Allow (this turn \xB7 edits only)";
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
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function showPanel(p) {
  if (!isEnabled()) {
    vscode.window.showWarningMessage("Edit Gate \u5DF2\u5173\u95ED\uFF08editGate.enabled\uFF09\u3002");
    return;
  }
  if (panel) {
    panel.reveal(vscode.ViewColumn.One, true);
    panel.webview.html = htmlFor(p);
    return;
  }
  panel = vscode.window.createWebviewPanel("editGate", "Edit Gate", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = htmlFor(p);
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.cmd === "approve") {
      const kind = readPending()?.kind;
      if (resolvePending("approved")) {
        vscode.window.showInformationMessage(
          kind === "batch_delete" ? "Edit Gate: \u5DF2\u6279\u51C6\u6279\u91CF\u5220\u9664\uFF0CMCP \u5C06\u7ACB\u5373\u6267\u884C\u6E05\u5355\u5185\u8DEF\u5F84\u3002" : "Edit Gate: approved edits for this agent turn (not deletes)."
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
    panel = void 0;
  });
}
function onPendingChanged() {
  if (!isEnabled()) {
    refreshStatusBar();
    if (panel) panel.dispose();
    return;
  }
  const p = readPending();
  if (!p || p.status !== "pending") {
    if (!p) shownId = void 0;
    refreshStatusBar();
    return;
  }
  refreshStatusBar();
  if (shownId === p.pending_id) return;
  shownId = p.pending_id;
  const msg = p.kind === "batch_delete" ? `Edit Gate: \u6279\u91CF\u5220\u9664 ${p.paths?.length || 0} \u9879\uFF0C\u8BF7\u786E\u8BA4\u8DEF\u5F84\u3002` : "Edit Gate: Agent requests permission to edit files.";
  vscode.window.showWarningMessage(msg, "Open panel").then((sel) => {
    if (sel === "Open panel") showPanel(p);
  });
  showPanel(p);
}
async function focusComposer() {
  const candidates = [
    "composer.focusComposer",
    "composer.startComposerPrompt",
    "aichat.focusInput",
    "workbench.action.chat.open"
  ];
  for (const cmd of candidates) {
    try {
      await vscode.commands.executeCommand(cmd);
      return true;
    } catch {
    }
  }
  return false;
}
async function sendPlaceholderAndCancel() {
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
    { windowsHide: true, timeout: 15e3 }
  );
}
async function runGhostContainment() {
  if (!isEnabled()) {
    vscode.window.showWarningMessage("Edit Gate \u5DF2\u5173\u95ED\uFF08editGate.enabled\uFF09\u3002");
    return;
  }
  if (containInFlight) return;
  containInFlight = true;
  try {
    const focused = await focusComposer();
    if (!focused) {
      vscode.window.showWarningMessage("Edit Gate: \u672A\u80FD\u805A\u7126\u804A\u5929\u8F93\u5165\u6846\u3002\u8BF7\u5148\u70B9\u51FB Agent \u8F93\u5165\u6846\uFF0C\u518D\u624B\u52A8\u53D1\u9001\u5E76 Cancel\u3002");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
    await sendPlaceholderAndCancel();
    vscode.window.showInformationMessage("Edit Gate: \u5DF2\u5C1D\u8BD5\u904F\u5236\u5E7D\u7075\uFF08\u5360\u4F4D\u53D1\u9001 + ~1s Stop\uFF09\u3002\u5B9E\u9A8C\u529F\u80FD\uFF0C\u4E0D\u4FDD\u8BC1\u9632\u6263\u8D39\u3002");
  } catch (err) {
    vscode.window.showErrorMessage(`Edit Gate: \u904F\u5236\u5E7D\u7075\u5931\u8D25\uFF1A${String(err)}`);
  } finally {
    containInFlight = false;
    refreshStatusBar();
  }
}
async function onStatusClick() {
  if (!isEnabled()) {
    const turnOn = await vscode.window.showInformationMessage(
      "Edit Gate \u5DF2\u5173\u95ED\u3002\u6253\u5F00\u603B\u5F00\u5173\uFF1F",
      "\u6253\u5F00 editGate.enabled"
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
function startWatch() {
  const dir = gateDir();
  fs.mkdirSync(dir, { recursive: true });
  try {
    watcher?.close();
  } catch {
  }
  watcher = fs.watch(dir, { persistent: true }, (_event, filename) => {
    const name = filename ? String(filename) : "";
    if (!name || name.includes("pending")) onPendingChanged();
    if (!name || name.includes("approval") || name.includes("config")) refreshStatusBar();
  });
  onPendingChanged();
  refreshStatusBar();
}
function activate(context) {
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
        vscode.window.showWarningMessage("Edit Gate \u5DF2\u5173\u95ED\uFF08editGate.enabled\uFF09\u3002");
        return;
      }
      const p = readPending();
      if (p?.status === "pending") showPanel(p);
      else vscode.window.showInformationMessage(p ? `No pending request (status: ${p.status}).` : `No pending edit request.
Watching: ${gateDir()}`);
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
function deactivate() {
  if (approvalExpiryTimer) clearTimeout(approvalExpiryTimer);
  try {
    watcher?.close();
  } catch {
  }
  panel?.dispose();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
