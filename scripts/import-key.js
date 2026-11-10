#!/usr/bin/env node
// 导入服务账号密钥到 keys/，校验后登记到 accounts.local.json。全程不打印密钥内容。
//
// 用法：
//   node scripts/import-key.js <账号名> --clipboard            # 从剪贴板读取（macOS pbpaste），成功后清空剪贴板
//   node scripts/import-key.js <账号名> --file <路径> [--move]  # 从下载的文件读取，--move 成功后删除源文件
// 可选：
//   --dataset <项目ID.数据集>   账单导出数据集，默认 <project_id>.billing_export
//   --billing-account <ID>      结算账号 ID（仅用于文档/控制台链接，可选）
//   --force                     覆盖已存在的 keys/gcp-key-<账号名>.json
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { REPO, DEFAULT_ACCOUNTS, repairJson, verifyKey, parseFlags } = require("./lib");

(async () => {
  const f = parseFlags(process.argv.slice(2));
  const name = f._[0];
  if (!name || /[\/\\\s]/.test(name) || (!f.clipboard && !f.file)) {
    console.error("用法: node scripts/import-key.js <账号名> --clipboard | --file <路径> [--move] [--dataset p.d] [--billing-account ID] [--force]");
    process.exit(2);
  }

  const raw = f.clipboard ? execFileSync("pbpaste").toString("utf8") : fs.readFileSync(f.file, "utf8");
  const { json: key, dropped } = repairJson(raw);
  for (const k of ["type", "project_id", "private_key_id", "private_key", "client_email"]) {
    if (!key[k]) throw new Error(`密钥缺少字段 ${k}`);
  }
  if (key.type !== "service_account") throw new Error("不是服务账号密钥（type 应为 service_account）");

  const v = await verifyKey(key);
  if (!v.ok) throw new Error("校验失败：" + v.reason);

  const keysDir = path.join(REPO, "keys");
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const rel = `keys/gcp-key-${name}.json`;
  const out = path.join(REPO, rel);
  if (fs.existsSync(out) && !f.force) throw new Error(`${rel} 已存在，确认要覆盖请加 --force`);
  fs.writeFileSync(out, JSON.stringify(key, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(out, 0o600);

  const accounts = fs.existsSync(DEFAULT_ACCOUNTS) ? JSON.parse(fs.readFileSync(DEFAULT_ACCOUNTS, "utf8")) : [];
  const prev = accounts.find((a) => a.name === name);
  const entry = {
    name,
    billingDataset: f.dataset || (prev && prev.billingDataset) || `${key.project_id}.billing_export`,
    projects: (prev && prev.projects) || [],
    keyFile: rel,
  };
  const billingAccount = f["billing-account"] || (prev && prev.billingAccount);
  if (billingAccount) entry.billingAccount = billingAccount;
  if (prev) Object.assign(prev, entry);
  else accounts.push(entry);
  fs.writeFileSync(DEFAULT_ACCOUNTS, JSON.stringify(accounts, null, 2) + "\n", { mode: 0o600 });

  if (f.clipboard) execFileSync("pbcopy", { input: "" });
  if (f.file && f.move) fs.unlinkSync(f.file);

  console.log(`✓ ${rel}`);
  console.log(`  client_email: ${key.client_email}`);
  console.log(`  与 Google 登记的公钥匹配；修复终端断行 ${dropped} 处`);
  console.log(`  accounts.local.json: ${prev ? "已更新" : "已新增"} ${name} → ${entry.billingDataset}`);
  if (f.clipboard) console.log("  剪贴板已清空");
  if (f.file && f.move) console.log("  源文件已删除");
})().catch((e) => {
  console.error("✗ " + e.message);
  process.exit(1);
});
