#!/usr/bin/env node
// 检查每个账号的账单数据集是否设置了分区过期（默认要求 90 天）。只读，不修改任何设置。
// 用法：node scripts/check-retention.js [--accounts <路径>] [--days 90]
"use strict";
const { loadAccounts, getAccessToken, parseFlags, DEFAULT_ACCOUNTS } = require("./lib");

const DAY_MS = 86400e3;

async function bq(token, path) {
  const res = await fetch("https://bigquery.googleapis.com/bigquery/v2/" + path, { headers: { Authorization: "Bearer " + token } });
  const j = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(j.error && j.error.message) || ""}`);
  return j;
}

const fmtDays = (ms) => (ms ? `${Math.round(Number(ms) / DAY_MS)} 天` : "未设置");

(async () => {
  const f = parseFlags(process.argv.slice(2));
  const want = Number(f.days || 90) * DAY_MS;
  let bad = 0;
  for (const a of loadAccounts(f.accounts || DEFAULT_ACCOUNTS)) {
    const [project, dataset] = (a.billingDataset || "").split(".");
    console.log(`▸ ${a.name}  ${a.billingDataset}`);
    try {
      const token = await getAccessToken(a.key);
      const base = `projects/${project}/datasets/${dataset}`;
      const ds = await bq(token, base);
      const dsOk = Number(ds.defaultPartitionExpirationMs) === want;
      if (!dsOk) bad++;
      console.log(`  ${dsOk ? "✓" : "✗"} 数据集默认分区过期：${fmtDays(ds.defaultPartitionExpirationMs)}`);

      const list = await bq(token, base + "/tables");
      const tables = (list.tables || []).filter((t) => /^gcp_billing_export_/.test(t.tableReference.tableId));
      if (!tables.length) console.log("  - 还没有账单导出表（开启导出后几小时才会出现）");
      for (const t of tables) {
        const id = t.tableReference.tableId;
        const info = await bq(token, `${base}/tables/${id}`);
        const tp = info.timePartitioning || {};
        const ok = Number(tp.expirationMs) === want && !info.expirationTime;
        if (!ok) bad++;
        let note = `分区过期：${fmtDays(tp.expirationMs)}`;
        if (!info.timePartitioning) note = "未分区，无法按分区过期";
        if (info.expirationTime) note += "；⚠ 设置了表过期时间，到期会删除整张表";
        console.log(`  ${ok ? "✓" : "✗"} ${id}  ${note}`);
      }
    } catch (e) {
      bad++;
      console.log("  ✗ " + e.message);
    }
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error("✗ " + e.message);
  process.exit(1);
});
