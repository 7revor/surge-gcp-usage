// 用真实 GCP 接口运行脚本：node test/live.js accounts.json
// accounts.json: [{ "name": "...", "billingDataset": "p.d", "projects": [], "keyFile": "/path/key.json" }]
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const accounts = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).map((a) => ({
  ...a,
  key: JSON.parse(fs.readFileSync(a.keyFile.replace(/^~/, process.env.HOME), "utf8")),
}));
const src = fs
  .readFileSync(path.join(__dirname, "..", "gcp-usage.js"), "utf8")
  .replace(/\/\/ <config>[\s\S]*?\/\/ <\/config>/, "const ACCOUNTS = __ACCOUNTS__;");

const http = (method) => (opts, cb) => {
  fetch(opts.url, { method, headers: opts.headers, body: opts.body, signal: AbortSignal.timeout((opts.timeout || 30) * 1000) })
    .then(async (r) => cb(null, { status: r.status, headers: Object.fromEntries(r.headers) }, await r.text()))
    .catch((e) => cb(String(e)));
};
const store = new Map();
const ctx = vm.createContext({
  __ACCOUNTS__: accounts,
  $httpClient: { get: http("GET"), post: http("POST") },
  $persistentStore: { read: (k) => store.get(k) ?? null, write: (v, k) => (store.set(k, v), true) },
  $notification: { post: () => {} },
  $argument: "",
  $done: (v) => console.log(v.title + "\n" + v.content),
});
vm.runInContext(src, ctx);
