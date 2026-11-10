#!/usr/bin/env node
// 生成填好密钥的 gcp-usage.js 并安装到 Surge 配置目录；可选把 [Script]/[Panel] 两行登记到指定配置文件。
//
// 用法：
//   node scripts/install-surge.js [--conf <配置文件>] [--surge-dir <目录>] [--interval 86400] [--dry-run] [--no-check]
//
//   --surge-dir  Surge 配置目录，默认 iCloud：~/Library/Mobile Documents/iCloud~com~nssurge~inc/Documents
//   --conf       含 [Script] 和 [Panel] 段的配置文件，相对 --surge-dir（例如 dconf/General.dconf 或 iOS.conf）。
//                已存在 gcp-usage 相关行时不重复添加。修改前备份到系统临时目录。
//   --interval   面板自动刷新间隔（秒），默认 86400
//   --dry-run    只打印将要做的事，不写文件
//   --no-check   安装后不运行一次真实查询
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadAccounts, buildSurgeScript, runInSurgeShim, parseFlags, DEFAULT_ACCOUNTS, DEFAULT_SURGE_DIR } = require("./lib");

(async () => {
  const f = parseFlags(process.argv.slice(2));
  const surgeDir = path.resolve(f["surge-dir"] || DEFAULT_SURGE_DIR);
  const interval = Number(f.interval || 86400);
  if (!fs.existsSync(surgeDir)) throw new Error(`Surge 目录不存在：${surgeDir}`);

  const accounts = loadAccounts(f.accounts || DEFAULT_ACCOUNTS);
  const script = buildSurgeScript(accounts);
  const target = path.join(surgeDir, "js", "gcp-usage.js");
  const scriptLine = "gcp-usage = type=generic,timeout=60,script-path=js/gcp-usage.js";
  const panelLine = `GCP = title=GCP 用量,content=加载中,style=info,script-name=gcp-usage,update-interval=${interval}`;

  console.log(`账号：${accounts.map((a) => a.name).join(", ")}`);
  if (f["dry-run"]) {
    console.log(`[dry-run] 将写入 ${target}`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existed = fs.existsSync(target);
    fs.writeFileSync(target, script, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    console.log(`✓ ${existed ? "已更新" : "已写入"} ${target}`);
  }

  if (f.conf) {
    const confPath = path.resolve(surgeDir, f.conf);
    const before = fs.readFileSync(confPath, "utf8");
    let text = before;
    text = ensureLine(text, "Script", scriptLine, /^\s*gcp-usage\s*=/m);
    text = ensureLine(text, "Panel", panelLine, /script-name=gcp-usage\b/);
    if (text === before) {
      console.log(`✓ ${f.conf} 已包含 gcp-usage 配置，未修改`);
    } else if (f["dry-run"]) {
      console.log(`[dry-run] 将修改 ${confPath}，新增：\n  ${scriptLine}\n  ${panelLine}`);
    } else {
      const bak = path.join(os.tmpdir(), `${path.basename(confPath)}.${Date.now()}.bak`);
      fs.writeFileSync(bak, before);
      fs.writeFileSync(confPath, text);
      console.log(`✓ 已登记到 ${f.conf}（原文件备份：${bak}）`);
    }
  } else {
    console.log(`未指定 --conf，请手动在 Surge 配置中加入：\n[Script]\n${scriptLine}\n\n[Panel]\n${panelLine}`);
  }

  if (!f["no-check"] && !f["dry-run"]) {
    console.log("\n--- 用安装后的脚本做一次真实查询 ---");
    const panel = await runInSurgeShim(fs.readFileSync(target, "utf8"));
    console.log(panel.title + "\n" + panel.content);
  }
})().catch((e) => {
  console.error("✗ " + e.message);
  process.exit(1);
});

/** 若 matcher 在全文中不存在，则把 line 追加到 [section] 段末尾（段不存在时在文件末尾新建） */
function ensureLine(text, section, line, matcher) {
  if (matcher.test(text)) return text;
  const lines = text.split("\n");
  const head = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (head < 0) return text.replace(/\n*$/, "") + `\n\n[${section}]\n${line}\n`;
  let end = head + 1;
  while (end < lines.length && !/^\s*\[.+\]\s*$/.test(lines[end])) end++;
  let insertAt = end;
  while (insertAt > head + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}
