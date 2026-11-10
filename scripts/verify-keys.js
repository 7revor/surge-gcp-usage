#!/usr/bin/env node
// 校验 accounts.local.json 中所有账号的密钥是否仍有效（与 Google 登记的公钥匹配）。
// 用法：node scripts/verify-keys.js [--accounts <路径>]
"use strict";
const { loadAccounts, verifyKey, parseFlags, DEFAULT_ACCOUNTS } = require("./lib");

(async () => {
  const f = parseFlags(process.argv.slice(2));
  const accounts = loadAccounts(f.accounts || DEFAULT_ACCOUNTS);
  let bad = 0;
  for (const a of accounts) {
    const v = await verifyKey(a.key);
    if (!v.ok) bad++;
    console.log(`${v.ok ? "✓" : "✗"} ${a.name.padEnd(12)} ${a.key.client_email}${v.ok ? "" : "  " + v.reason}`);
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error("✗ " + e.message);
  process.exit(1);
});
