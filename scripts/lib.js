// 本地工具脚本共用的函数（Node 18+，仅在开发机上运行，不会进入 Surge）
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "gcp-usage.js");
const DEFAULT_ACCOUNTS = path.join(REPO, "accounts.local.json");
const DEFAULT_SURGE_DIR = path.join(os.homedir(), "Library/Mobile Documents/iCloud~com~nssurge~inc/Documents");
const CONFIG_RE = /\/\/ <config>[\s\S]*?\/\/ <\/config>/;

/** 读取 accounts.local.json，keyFile 相对该文件所在目录解析，返回带 key 对象的账号列表 */
function loadAccounts(file = DEFAULT_ACCOUNTS) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`找不到 ${abs}，参考 accounts.example.json 创建`);
  const list = JSON.parse(fs.readFileSync(abs, "utf8"));
  return list.map((a) => {
    const keyPath = path.resolve(path.dirname(abs), a.keyFile.replace(/^~(?=\/)/, os.homedir()));
    const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    if (key.type !== "service_account") throw new Error(`${keyPath} 不是服务账号密钥`);
    return { name: a.name, billingDataset: a.billingDataset, projects: a.projects || [], key, keyPath };
  });
}

/** 生成填好配置的 Surge 脚本内容 */
function buildSurgeScript(accounts) {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const cfg = accounts.map((a) => ({
    name: a.name,
    billingDataset: a.billingDataset,
    projects: a.projects,
    key: pick(a.key, ["type", "project_id", "private_key_id", "private_key", "client_email", "token_uri"]),
  }));
  const block = "// <config>\nconst ACCOUNTS = " + JSON.stringify(cfg, null, 2) + ";\n// </config>";
  if (!CONFIG_RE.test(src)) throw new Error("gcp-usage.js 中找不到 // <config> 区块");
  return src.replace(CONFIG_RE, () => block);
}

/** 在 Node 中模拟 Surge 运行脚本（真实网络请求），返回 $done 的面板对象 */
function runInSurgeShim(src, { trigger = "button", argument = "" } = {}) {
  return new Promise((resolve) => {
    const http = (method) => (o, cb) =>
      fetch(o.url, { method, headers: o.headers, body: o.body, signal: AbortSignal.timeout((o.timeout || 30) * 1000) })
        .then(async (r) => cb(null, { status: r.status, headers: Object.fromEntries(r.headers) }, await r.text()))
        .catch((e) => cb(String(e)));
    const store = new Map();
    const ctx = vm.createContext({
      $httpClient: { get: http("GET"), post: http("POST") },
      $persistentStore: { read: (k) => store.get(k) ?? null, write: (v, k) => (store.set(k, v), true) },
      $notification: { post() {} },
      $trigger: trigger,
      $argument: argument,
      $done: resolve,
    });
    vm.runInContext(src, ctx);
  });
}

/** 修复从终端复制时被软换行打断的 JSON：去掉字符串内部的真实换行符 */
function repairJson(raw) {
  let out = "";
  let inStr = false;
  let esc = false;
  let dropped = 0;
  for (const ch of raw) {
    if (inStr) {
      if (ch === "\r" || ch === "\n") {
        // 字符串内的真实换行一定是终端断行产生的（包括恰好断在 \ 和 n 之间）
        dropped++;
        continue;
      }
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    out += ch;
  }
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("内容中没有 JSON 对象");
  return { json: JSON.parse(out.slice(start, end + 1)), dropped };
}

/** 用 Google 公布的 x509 证书校验私钥与 private_key_id 是否匹配 */
async function verifyKey(key) {
  const pub = crypto.createPublicKey(crypto.createPrivateKey(key.private_key)).export({ type: "spki", format: "pem" });
  const res = await fetch("https://www.googleapis.com/service_accounts/v1/metadata/x509/" + encodeURIComponent(key.client_email));
  if (!res.ok) return { ok: false, reason: `证书接口 HTTP ${res.status}（服务账号可能已删除）` };
  const certs = await res.json();
  const pem = certs[key.private_key_id];
  if (!pem) return { ok: false, reason: "Google 上找不到该 private_key_id（密钥可能已删除）" };
  const gpub = new crypto.X509Certificate(pem).publicKey.export({ type: "spki", format: "pem" });
  return gpub === pub ? { ok: true } : { ok: false, reason: "私钥与 Google 登记的公钥不匹配" };
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] !== undefined) r[k] = o[k];
  return r;
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else flags._.push(a);
  }
  return flags;
}

module.exports = {
  REPO,
  SCRIPT,
  DEFAULT_ACCOUNTS,
  DEFAULT_SURGE_DIR,
  loadAccounts,
  buildSurgeScript,
  runInSurgeShim,
  repairJson,
  verifyKey,
  parseFlags,
};
