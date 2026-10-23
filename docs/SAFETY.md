# Safety model

> Legal disclaimer: [DISCLAIMER.md](../DISCLAIMER.md). Authors are not liable for data loss or damages.

Edit Gate is a **Cursor hook + MCP approval** layer. It is **not** an OS sandbox.

## What it blocks

| Action | Behavior |
|--------|----------|
| Shell batch / recursive / wildcard delete (`Remove-Item -Recurse`, `rm -rf`, `rd /s`, pipelines, …) | Always **denied**. Use `request_batch_delete`. |
| Cursor `Write` / `StrReplace` / `EditNotebook` / mutating Shell without approval | **Denied** until `request_edit_approval` + Allow |
| Cursor `Delete` or Shell single-file delete without approval | **Denied** until edit approval |
| Fast single-deletes (Delete **or** Shell single-file, shared counter) | **Fuse** if **>6** in **10s**, or **>10** in the current agent turn → both single-delete channels blocked for the rest of the turn |

## What it allows (after Allow)

- Edits for the current agent turn
- Occasional single-file deletes (until fuse)
- `request_batch_delete`: panel lists every absolute path → Allow → MCP deletes only that list (files by default)

## What it does **not** guarantee

- Full OS isolation (Windows Agent terminals can still be powerful once approved)
- Protection if you disable `editGate.enabled` (batch shell deletes still blocked; edit gate opens)
- Protection if hooks fail to load or Node is missing (`failClosed` helps, but verify Hooks in Cursor settings)
- Protection against you manually running deletes in your own terminal outside the Agent

## Installer safety

`install.ps1` only writes under `%USERPROFILE%\.cursor\` (and installs a VSIX via Cursor CLI). It does **not** recursively wipe drives or project folders. It backs up `hooks.json` / `mcp.json` before changing them.
