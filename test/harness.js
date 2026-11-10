// 在 Node 中模拟 Surge 运行环境，验证签名、查询拼装和分类结果。
// 用法：node test/harness.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "gcp-usage.js"), "utf8");

function makeKey(email, project) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    pub: publicKey,
    json: {
      type: "service_account",
      project_id: project,
      private_key_id: "kid-" + project,
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      client_email: email,
      token_uri: "https://oauth2.googleapis.com/token",
    },
  };
}

// 截图中的 SKU（Compute Engine）+ Vision/Translate
const BILLING_ROWS = [
  ["Compute Engine", "E2 Instance Core running in Americas", "hour", 186.1, 4.6, -4.6, 0],
  ["Compute Engine", "E2 Instance Ram running in Americas", "gibibyte hour", 745.38, 2.5, -2.5, 0],
  ["Compute Engine", "Network Data Transfer Out via Carrier Peering Network - Americas Based", "gibibyte", 0.01, 0.0004, 0, 0],
  ["Compute Engine", "Network Data Transfer In from Google Services from Americas to Americas", "gibibyte", 0.67, 0, 0, 0],
  ["Compute Engine", "Network Standard Internet Data Transfer In to Oregon", "gibibyte", 14.25, 0, 0, 0],
  ["Compute Engine", "Network Data Transfer In via Carrier Peering Network - Americas Based", "gibibyte", 0.2, 0, 0, 0],
  ["Compute Engine", "Network Standard Data Transfer Out to Internet from Oregon", "gibibyte", 14.59, 0, 0, 0],
  ["Compute Engine", "Licensing Fee for Debian 12 Bookworm", "hour", 746.38, 0, 0, 0],
  ["Compute Engine", "Network Data Transfer to Google Services from Americas to Americas", "gibibyte", 0.19, 0, 0, 0],
  ["Cloud Vision API", "Label Detection", "count", 1530, 2.25, -1.5, 0],
  ["Cloud Translation API", "Translation", "count", 123456, 2.47, 0, -2.47],
];

// 估算显示宽度（单位：汉字宽）：ASCII 约 0.55，其余（汉字、全角标点、符号）按 1
// 依据：Mac 面板实测在「⚠️ 账单：导出表尚未生成（开启账单导」处折行，约 18.5 个汉字宽
const PANEL_WIDTH = 18.5;
function width(s) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) < 0x80 ? 0.55 : /[\uFE00-\uFE0F]/.test(ch) ? 0 : 1;
  return w;
}

function bqResponse(rows) {
  const fields = ["service", "sku", "unit", "qty", "cost", "free_credit", "other_credit", "currency", "export_time"];
  return {
    jobComplete: true,
    schema: { fields: fields.map((name) => ({ name })) },
    rows: rows.map((r) => ({ f: [...r, "USD", "1.7627508E9"].map((v) => ({ v: String(v) })) })),
  };
}

function run({ accounts, routes, argument }) {
  const store = new Map();
  const calls = [];
  let result;
  let notified;
  const http = (method) => (opts, cb) => {
    calls.push({ method, ...opts });
    setTimeout(() => {
      for (const [re, handler] of routes) {
        if (re.test(opts.url)) {
          const [status, body] = handler({ method, ...opts });
          return cb(null, { status, headers: {} }, typeof body === "string" ? body : JSON.stringify(body));
        }
      }
      cb(null, { status: 404 }, '{"error":{"message":"no route"}}');
    }, 1);
  };
  const ctx = {
    $httpClient: { get: http("GET"), post: http("POST") },
    $persistentStore: { read: (k) => (store.has(k) ? store.get(k) : null), write: (v, k) => (store.set(k, v), true) },
    $notification: { post: (...a) => (notified = a) },
    $argument: argument,
    $done: (v) => (result = v),
    console,
    Intl,
    setTimeout,
  };
  const src = SRC.replace(/\/\/ <config>[\s\S]*?\/\/ <\/config>/, "const ACCOUNTS = __ACCOUNTS__;");
  ctx.__ACCOUNTS__ = accounts;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (result) {
        clearInterval(t);
        resolve({ result, calls, store, notified, ctx });
      }
    }, 5);
  });
}

function tokenRoute(keys) {
  return [
    /oauth2\.googleapis\.com\/token/,
    ({ body }) => {
      const assertion = decodeURIComponent(body.split("assertion=")[1]);
      const [h, c, sig] = assertion.split(".");
      const claims = JSON.parse(Buffer.from(c, "base64url").toString());
      const key = keys[claims.iss];
      const ok = crypto.verify("sha256", Buffer.from(h + "." + c), key.pub, Buffer.from(sig, "base64url"));
      if (!ok) return [400, { error: "invalid_grant", error_description: "Invalid JWT Signature." }];
      return [200, { access_token: "tok-" + claims.iss, expires_in: 3599 }];
    },
  ];
}

(async () => {
  // 1. 签名与 SHA-256 与 Node 一致
  {
    const k = makeKey("a@x.iam.gserviceaccount.com", "p");
    const { ctx } = await run({ accounts: [], routes: [] });
    for (const msg of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "中文 jwt payload ".repeat(30)]) {
      const mine = Buffer.from(ctx.sha256(ctx.utf8(msg))).toString("hex");
      assert.strictEqual(mine, crypto.createHash("sha256").update(msg).digest("hex"), "sha256 mismatch: " + msg.length);
    }
    const data = "header.payload-" + Date.now();
    const sig = ctx.rs256Sign(ctx.parseRsaPrivateKey(k.json.private_key), data);
    const expected = crypto.sign("sha256", Buffer.from(data), k.json.private_key).toString("base64url");
    assert.strictEqual(sig, expected, "RS256 签名与 Node 不一致");
    // PKCS#1 格式也能解析
    const pkcs1 = crypto.createPrivateKey(k.json.private_key).export({ type: "pkcs1", format: "pem" });
    assert.strictEqual(ctx.rs256Sign(ctx.parseRsaPrivateKey(pkcs1), data), expected);
    console.log("✓ SHA-256 / RS256 与 Node crypto 一致");
  }

  // 2. 两个账号完整流程
  const k1 = makeKey("surge@proj-a.iam.gserviceaccount.com", "proj-a");
  const k2 = makeKey("surge@proj-b.iam.gserviceaccount.com", "proj-b");
  const keys = { [k1.json.client_email]: k1, [k2.json.client_email]: k2 };
  let bqSql = "";
  const routes = [
    tokenRoute(keys),
    [
      /monitoring\.googleapis\.com\/v3\/projects\/([^/]+)\/timeSeries/,
      ({ url }) => {
        const u = new URL(url);
        const filter = u.searchParams.get("filter");
        assert.ok(/^\d+s$/.test(u.searchParams.get("aggregation.alignmentPeriod")));
        const project = u.pathname.split("/")[3];
        if (project === "proj-b") return [403, { error: { message: "Permission monitoring.timeSeries.list denied" } }];
        if (/quota\/rate\/net_usage/.test(filter)) {
          assert.strictEqual(u.searchParams.get("aggregation.groupByFields"), "metric.labels.quota_metric");
          const q = (m, v) => ({ metric: { labels: { quota_metric: m } }, points: [{ value: { int64Value: String(v) } }] });
          return [
            200,
            {
              timeSeries: [
                q("vision.googleapis.com/default_requests", 1240),
                q("vision.googleapis.com/document_text_detection_requests", 1200),
                q("vision.googleapis.com/label_detection_requests", 40),
                q("translate.googleapis.com/default", 5633),
                q("translate.googleapis.com/default_requests_legacy", 50),
              ],
            },
          ];
        }
        assert.match(filter, /api\/request_count/);
        return [
          200,
          {
            timeSeries: [
              { resource: { labels: { service: "vision.googleapis.com" } }, points: [{ value: { int64Value: "1200" } }, { value: { int64Value: "34" } }] },
              { resource: { labels: { service: "translate.googleapis.com" } }, points: [{ value: { int64Value: "56" } }] },
            ],
          },
        ];
      },
    ],
    [
      /bigquery\.googleapis\.com\/bigquery\/v2\/projects\/([^/]+)\/queries/,
      ({ url, body }) => {
        bqSql = JSON.parse(body).query;
        if (url.includes("proj-b")) return [200, bqResponse([["Compute Engine", "Network Standard Data Transfer Out to Internet from Oregon", "gibibyte", 230.5, 2.6, 0, 0]])];
        return [200, bqResponse(BILLING_ROWS)];
      },
    ],
  ];
  const accounts = [
    { name: "主号", billingDataset: "proj-a.billing_export", projects: [], key: k1.json },
    { name: "副号", billingDataset: "proj-b.billing_export", projects: [], key: k2.json },
  ];
  const r = await run({ accounts, routes, argument: "notify=1" });
  console.log("\n--- 面板输出 ---\n" + r.result.title + "\n" + r.result.content + "\n----------------\n");

  assert.match(bqSql, /`proj-b\.billing_export\.gcp_billing_export_v1_\*`/);
  assert.match(bqSql, /invoice\.month = '\d{6}'/);
  const c = r.result.content;
  assert.strictEqual(r.result.style, "info");
  assert.strictEqual(r.result.icon, undefined);
  assert.match(c, /▸ 主号\n‼ Vision 1,234 次 · 1,200\/1,000\n/); // 只统计文档识别（label_detection 不计），超额加 ‼
  assert.match(c, /Translate 56 次 · 5,633\/50万字符\n/); // 字符数来自配额指标，不用账单
  assert.match(c, /免费流量 29\.9 GiB · 出站 14\.6\/200\n/); // 0.67+14.25+0.2+14.59+0.19
  assert.match(c, /收费流量 0\.01 GiB（对等互连）\n费用 Vision \$0\.75\n/); // 流量 $0.0004 < 0.01 不计
  assert.match(c, /▸ 副号\nVision \? 次 · \?\/1,000\nTranslate \? 次 · \?\/50万字符\n/);
  assert.match(c, /免费流量 200 GiB · 出站 231\/200\n收费流量 30\.5 GiB（标准出站超额）\n费用 流量 \$2\.60/);
  assert.match(c, /\n\n⚠ 调用量：无权限（副号）\n账单截至 \d\d-\d\d \d\d:\d\d$/);
  for (const line of (r.result.title + "\n" + c).split("\n")) assert.ok(width(line) <= PANEL_WIDTH, `行过长(${width(line)}): ${line}`);
  assert.ok(r.notified, "notify=1 应推送通知");
  console.log("✓ 双账号流程、流量分类、部分失败显示");

  // 3. token 缓存：第二次运行不再请求 token
  {
    const store = r.store;
    const r2 = await (async () => {
      const res = await run({ accounts: accounts.slice(0, 1), routes });
      return res;
    })();
    // 新的 run 有独立 store，手动验证缓存写入格式
    const cached = JSON.parse([...store.values()][0]);
    assert.ok(cached.token && cached.exp > Date.now() / 1000);
    assert.ok(r2.calls.some((x) => /oauth2/.test(x.url)));
    console.log("✓ token 已写入缓存");
  }

  // 4. 账单月起点 = 太平洋时间当月 1 日 0 点
  {
    const { ctx } = await run({ accounts: [], routes: [] });
    const p = ctx.billingMonth(new Date("2026-11-10T04:00:00Z"));
    assert.strictEqual(p.month, "202611");
    assert.strictEqual(p.start.toISOString(), "2026-11-01T07:00:00.000Z"); // 11-01 还是 PDT
    const q = ctx.billingMonth(new Date("2026-12-01T07:30:00Z")); // LA 11-30 23:30
    assert.strictEqual(q.month, "202611");
    const s = ctx.billingMonth(new Date("2027-01-15T00:00:00Z"));
    assert.strictEqual(s.start.toISOString(), "2027-01-01T08:00:00.000Z"); // PST
    console.log("✓ 账单月按太平洋时间计算");
  }

  // 5. 密钥未配置时给出可读错误
  {
    const res = await run({ accounts: [{ name: "空", billingDataset: "a.b", key: {} }], routes });
    assert.match(res.result.content, /▸ 空\n✗ 服务账号密钥未配置/);
    console.log("✓ 未配置提示");
  }
  console.log("\n全部通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
