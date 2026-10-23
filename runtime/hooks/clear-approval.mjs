#!/usr/bin/env node
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const storePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "edit-gate", "approval-store.mjs");
const storeUrl = pathToFileURL(storePath).href;

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", async () => {
  try {
    const { clearTurnGrant } = await import(storeUrl);
    clearTurnGrant();
  } catch {
    // best-effort
  }
  process.stdout.write("{}");
});
