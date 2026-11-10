#!/usr/bin/env node
// 用真实 GCP 接口运行脚本（不修改任何文件）。
// 用法：node test/live.js [--accounts accounts.local.json]
"use strict";
const { loadAccounts, buildSurgeScript, runInSurgeShim, parseFlags, DEFAULT_ACCOUNTS } = require("../scripts/lib");

(async () => {
  const f = parseFlags(process.argv.slice(2));
  const panel = await runInSurgeShim(buildSurgeScript(loadAccounts(f.accounts || DEFAULT_ACCOUNTS)));
  console.log(`${panel.title}  [icon=${panel.icon}]\n${panel.content}`);
})().catch((e) => {
  console.error("✗ " + e.message);
  process.exit(1);
});
