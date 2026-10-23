# Edit Gate for Cursor (Windows)

Cursor Agent 的**写操作门禁**与**删除安全层**：先申请、你点 Allow，再改文件；批量删必须走清单面板；并降低「幽灵续跑」在未批准时继续乱写的风险。

> **不是**操作系统沙箱。详见 [docs/SAFETY.md](docs/SAFETY.md) 与 [DISCLAIMER.md](DISCLAIMER.md)。

## 免责声明 / Disclaimer

**本软件按「现状」提供，作者不对因插件缺陷、配置错误、误点 Allow、关闭防护或其它使用不当导致的数据丢失、系统损坏或任何损失承担责任。请先在测试目录验证并自行备份。使用即表示接受 [DISCLAIMER.md](DISCLAIMER.md)。**

THE SOFTWARE IS PROVIDED "AS IS". USE AT YOUR OWN RISK. Full text: [DISCLAIMER.md](DISCLAIMER.md).

---

## Cursor 版本与界面适配

Edit Gate 依赖 Cursor 的 **Agent Hooks**（`preToolUse` / `beforeShellExecution` / `stop` 等）、自定义 **MCP**，以及 VS Code 式 **扩展面板**（批准 / 批量删除清单）。没有 Hooks 的旧版无法硬拦写入与批量删除；没有 IDE 侧栏面板则无法点 Allow / 确认批量删。

### 界面（比版本更关键）

新版 Cursor 常见两种主界面：

| 界面 | 形态 | 与本插件 |
|------|------|----------|
| **IDE** | 类 VS Code：侧栏、扩展、Settings、MCP / Hooks 面板 | **支持（本插件目标环境）** |
| **Agent** | 类 Codex：偏对话 / Agent 工作台，弱化传统 IDE 壳 | **不适用** — 无稳定扩展 UI / 面板交互，请切回 IDE 界面再使用 |

请在 **IDE 界面**安装与使用。若你当前是 Agent-only 布局，先切到带侧栏与扩展的 IDE 视图，再按下文安装步骤操作。

### 版本

| 级别 | 版本 | 说明 |
|------|------|------|
| **推荐** | **Cursor 3.x**（最新稳定版）+ **IDE 界面** | Hooks / MCP / 扩展面板完整 |
| **已验证** | **Cursor 3.0.8**（IDE 界面） | 本仓库开发与功能测试所用环境 |
| **最低尝试** | **Cursor ≥ 1.7** + IDE 界面 | 起具备用户级 Hooks；功能可能不完整，需自行验证 |
| **不支持** | **&lt; 1.7**，或 **Agent-only 界面** | 无 Hooks 门禁，或无法完成面板批准 / 批量确认 |

UI 扩展声明 `engines.vscode: ^1.85.0`（随 Cursor 内置引擎；3.x IDE 一般均满足）。

**验收标准：** 在 **IDE 界面**下打开 **Settings → Hooks**，应能看到 `gate-edits.mjs`，且侧栏能打开 Edit Gate 面板。若没有，请升级 Cursor 或切回 IDE 界面后再装。

查看本机版本：**Help → About**。

---

## 软件要解决什么？

面向 Cursor **Agent 自动执行工具**时的两类常见事故：

| 问题 | 含义 | Edit Gate 怎么帮 |
|------|------|------------------|
| **误清盘** | Agent 用 Shell 批量/递归删除，或路径写错，把整盘/大目录清空 | 永久拦截 Shell 批量删；批量删改为 `request_batch_delete`（面板列出每一条路径再执行）；单删有双防卫熔断 |
| **幽灵用户消息** | 没有你新发的真实指令，Agent 却像「又收到消息」一样续跑、扣费、继续改文件 | Agent **stop** 时清空本轮写权限；未批准时 Write/Shell/Delete 被 Hook 拦住，幽灵即使续跑也难直接落盘 |

额外能力：编辑前强制说明意图与路径；状态栏提示等待审批；可选项目规则提醒模型走正规工具。

---

## 原理简述

三块拼在一起：

```text
  Agent 要改文件 / 跑 Shell
           │
           ▼
  ┌─────────────────────┐
  │  Cursor Hooks       │  gate-edits.mjs
  │  preToolUse /       │  · 无批准 → deny 写入类工具
  │  beforeShellExecution│  · Shell 批量删 → 永远 deny
  │                     │  · 单删过快/过多 → 本轮熔断
  └─────────┬───────────┘
            │ 已批准 / 放行
            ▼
       真正执行工具

  申请与批量删除：
  Agent ──MCP──► edit-gate server ──写 pending.json──► Edit Gate UI 面板
                      ▲ Allow/Deny ◄── 你点击
```

1. **Hooks（硬拦）**  
   在工具真正执行前拦 `Write` / `StrReplace` / `Delete` / `EditNotebook` / `Shell`。没有本轮批准就 deny。Shell 批量/递归/通配删除**不看批准**，一律 deny。

2. **MCP（申请通道）**  
   - `request_edit_approval`：说明 reason + paths → 你 Allow → 本轮获得**编辑权**  
   - `request_batch_delete`：交上绝对路径列表 → 面板核对 → Allow 后由 **MCP 进程按清单删除**（不经过危险 Shell 命令）

3. **UI 扩展**  
   监听 `pending.json`，弹出 Allow/Deny；状态栏显示等待/授权中；stop 后批准被清空，降低幽灵接盘续写。

配置在 `%USERPROFILE%\.cursor\edit-gate\config.json`。

---

## 使用教程

### 1. 安装

**要求：** Windows 10/11、Node.js（`node` / `npm`）、已安装 Cursor（`cursor` 命令可用）。

```powershell
cd path\to\edit-gate_cursor
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

- 默认会确认；同意免责后再装（可用 `-Yes` 跳过确认）  
- **只写入** `%USERPROFILE%\.cursor\`  
- 备份并更新 `hooks.json`，**合并**（不删其它服务器）`mcp.json` 中的 `edit-gate`  
- 安装 `vsix\` 里的 Edit Gate UI  

然后**完全退出 Cursor（含托盘）再打开**。

可选：把 `rules\require-edit-approval.mdc` 拷到你项目的 `.cursor\rules\`，让模型默认走申请流程。

### 2. 确认装好了

1. 设置搜索 **`editGate.enabled`** → 打开  
2. 状态栏出现 **Edit Gate**  
3. Settings → **Hooks** 能看到 `gate-edits.mjs`  
4. MCP 里有工具：`request_edit_approval`、`request_batch_delete`、`check_edit_approval`

### 3. 日常：让 Agent 改代码

1. 用 **Agent** 模式交代任务  
2. 模型应先调用 **`request_edit_approval`**（写清要干什么、涉及哪些路径）  
3. 弹出面板 → 核对后点 **Allow (this turn)**  
4. 本轮内可 Write / StrReplace / 普通 Shell  
5. 本轮结束（stop）后批准失效；下一轮要再改必须重新申请  

未批准时改文件会被 Hook 拦截（接近「只能读、不能写」）。

### 4. 日常：批量删除文件

1. **不要**让 Agent 跑 `Remove-Item -Recurse` / `rm -rf` / `rd /s` 等（会被永久拦截）  
2. 让模型列好**全部绝对路径**，调用 **`request_batch_delete`**  
3. 面板会列出每一条路径 → 确认无误后点 **Allow 删除**  
4. 由 MCP 只删清单内文件（默认不删目录，除非显式 `allowDirectories: true`）

### 5. 单文件删除

- 有编辑批准后，可用 Cursor **Delete** 或 Shell **单文件**删除  
- **双防卫熔断**（Delete 与 Shell 单删共用计数）：  
  - 任意 **10 秒内超过 6 次**单删 → 本轮熔断  
  - 本轮累计 **超过 10 次**单删 → 本轮熔断  
- 熔断后本轮两种单删都禁用，请改用 `request_batch_delete`

### 6. 关于幽灵续跑

- 批准只在**当前 Agent 轮次**有效，结束即清  
- 无批准时写入类工具进不了盘，幽灵续跑也难直接改仓库  
- UI 另有实验性「遏制幽灵」操作（状态栏点击，不保证防扣费）  
- 建议：空消息 / 莫名 continue 时先 Stop，不要随手 Allow

### 7. 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

---

## Agent 工具速查

| 目的 | 调用 |
|------|------|
| 申请本轮编辑 | `request_edit_approval` |
| 安全批量删 | `request_batch_delete` |
| 查询是否已批准编辑 | `check_edit_approval` |

## 配置默认值

| 键 | 默认 | 含义 |
|----|------|------|
| `singleDeleteWindowMs` | `10000` | 单删滑动时间窗 |
| `singleDeleteBurstLimit` | `6` | 窗内超过该次数熔断 |
| `singleDeleteMaxPerTurn` | `10` | 本轮超过该次数熔断 |
| `batchDeleteMaxPaths` | `100` | 单次批量删路径上限 |

文件：`%USERPROFILE%\.cursor\edit-gate\config.json`（首次安装来自 `config.default.json`）。

## Requirements

- Windows 10/11  
- [Node.js](https://nodejs.org/) on `PATH`  
- **Cursor 3.x + IDE 界面**推荐（已在 **3.0.8** IDE 验证；最低尝试 1.7+；**Agent-only 界面不适用**，见上文「Cursor 版本与界面适配」）  
- Cursor CLI (`cursor`) 可用于安装 VSIX  

## Repository layout

```text
edit-gate_cursor/
  install.ps1 / uninstall.ps1
  runtime/edit-gate/     # MCP + 删除策略 + 熔断
  runtime/hooks/         # gate-edits / clear-approval
  ui/ + vsix/            # 审批面板扩展
  rules/                 # 可选项目规则
  docs/SAFETY.md
  DISCLAIMER.md
```

重建 VSIX：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-vsix.ps1
```

## Verify（建议先在扔弃目录测）

1. 无批准改文件 → 应被拦  
2. `Remove-Item -Recurse` → 应被拦  
3. `request_batch_delete` → 面板路径正确后再 Allow  
4. 快连 Delete 超过 6 次/10s → 本轮单删熔断  

## Disclaimer

完整条款见 **[DISCLAIMER.md](DISCLAIMER.md)**。Hook/UI 可能失效；重要数据请自行备份；Allow 前务必看清路径。
