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
  const fields = ["service", "sku", "unit", "qty", "cost", "free_credit", "other_credit", "currency", "usage_end"];
  return {
    jobComplete: true,
    schema: { fields: fields.map((name) => ({ name })) },
    rows: rows.map((r) => ({ f: [...r, "USD", "1.7627508E9"].map((v) => ({ v: String(v) })) })),
  };
}

function run({ accounts, routes, argument, store = new Map() }) {
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
  assert.ok(!r.calls.some((x) => /request_count/.test(decodeURIComponent(x.url))), "默认配置不显示调用次数，不应再查询 request_count");
  console.log("\n--- 面板输出 ---\n" + r.result.title + "\n" + r.result.content + "\n----------------\n");

  assert.match(bqSql, /`proj-b\.billing_export\.gcp_billing_export_v1_\*`/);
  assert.match(bqSql, /invoice\.month = '\d{6}'/);
  const c = r.result.content;
  assert.strictEqual(r.result.style, undefined); // 用 SF Symbol 图标表示状态，不用 style
  assert.strictEqual(r.result.icon, "cloud.fill");
  assert.strictEqual(r.result["icon-color"], "#FF3B30"); // 有超额 → 红
  assert.match(r.result.title, /^GCP · \$3\.35 · \d\d:\d\d$/); // 标题带本月费用合计
  assert.match(c, /▸ 主号 · thru \d\d-\d\d \d\d:\d\d\n▰▰▰▰▰‼ Vision 1,200 \/ 1,000\n/); // 只统计文档识别（label_detection 不计），超额时末格为 ‼；不显示调用次数
  assert.match(c, /▰▱▱▱▱▱ Translate 5\.6K \/ 500K\n/); // 字符数来自配额指标，不用账单；有用量时至少 1 格
  assert.match(c, /Cost: Vision \$0\.75\n▰▱▱▱▱▱ Free 14\.6G \/ 200G\nPaid 0\.01G · \$0\.0004\n/); // Free 只算标准层出站；Paid 为对等互连
  assert.match(bqSql, /MAX\(usage_end_time\) AS usage_end FROM m\)/); // 截止时间取整张表，不限服务
  assert.match(bqSql, /LEFT JOIN g ON TRUE/);
  assert.match(c, /▸ 副号 · thru \d\d-\d\d \d\d:\d\d\n▱▱▱▱▱▱ Vision \? \/ 1,000\n▱▱▱▱▱▱ Translate \? \/ 500K\n/); // 数据缺失时进度条全空
  assert.match(c, /Translate \? \/ 500K\n▰▰▰▰▰‼ Free 231G \/ 200G\nPaid 30\.5G · \$2\.60\n/); // 标准出站超额计入 Paid
  assert.match(c, /\n\n⚠ 用量：无权限（副号）$/); // 截止时间在各账号标题上，页脚不再显示
  assert.doesNotMatch(c, /账单截至/);
  for (const line of (r.result.title + "\n" + c).split("\n")) assert.ok(width(line) <= PANEL_WIDTH, `行过长(${width(line)}): ${line}`);
  assert.ok(r.notified, "notify=1 应推送通知");
  console.log("✓ 双账号流程、流量分类、部分失败显示");

  // 3. token 缓存：共用同一个 store 时，第二次运行不再请求 token
  {
    const one = accounts.slice(0, 1);
    const cacheKey = "gcp_usage.token." + k1.json.client_email;
    const r1 = await run({ accounts: one, routes });
    assert.strictEqual(r1.calls.filter((x) => /oauth2/.test(x.url)).length, 1);
    const cached = JSON.parse(r1.store.get(cacheKey));
    assert.ok(cached.token && cached.exp > Date.now() / 1000);
    const r2 = await run({ accounts: one, routes, store: r1.store });
    assert.strictEqual(r2.calls.filter((x) => /oauth2/.test(x.url)).length, 0, "第二次运行应使用缓存的 token");
    assert.match(r2.result.content, /Vision 1,200 \/ 1,000/);
    console.log("✓ token 缓存生效");

    // 缓存的 token 已失效（401）：丢弃缓存，重新签发后重试一次
    const store = new Map([[cacheKey, JSON.stringify({ token: "stale", exp: Math.floor(Date.now() / 1000) + 3000 })]]);
    const reject401 = routes.map(([re, h]) => [
      re,
      (o) => (o.headers && o.headers.Authorization === "Bearer stale" ? [401, { error: { message: "Invalid Credentials" } }] : h(o)),
    ]);
    const r3 = await run({ accounts: one, routes: reject401, store });
    assert.strictEqual(r3.calls.filter((x) => /oauth2/.test(x.url)).length, 1);
    assert.doesNotMatch(r3.result.content, /密钥无效|⚠/);
    assert.match(r3.result.content, /Vision 1,200 \/ 1,000/);
    assert.match(r3.result.content, /\n▰▱▱▱▱▱ Free 14\.6G \/ 200G/);
    assert.strictEqual(JSON.parse(store.get(cacheKey)).token, "tok-" + k1.json.client_email);
    console.log("✓ token 失效时自动重新签发");
  }

  // 3b. 标准层出站：是否收费以账单为准
  {
    const { ctx } = await run({ accounts: [], routes: [] });
    const row = (region, qty, cost) => ({
      service: "Compute Engine",
      sku: `Network Standard Data Transfer Out to Internet from ${region}`,
      unit: "gibibyte",
      qty,
      cost,
      free_credit: 0,
      other_credit: 0,
      currency: "USD",
    });
    // 两个区域各 150：合计超过 200，但账单为 0 → 全部免费
    let s = ctx.summarizeBilling([row("Oregon", 150, 0), row("Iowa", 150, 0)]);
    assert.deepStrictEqual([s.stdGiB, s.stdOverGiB, s.freeGiB, s.paidGiB, s.paidCost], [300, 0, 300, 0, 0]);
    s.usageEnd = 1;
    assert.match(ctx.renderAccount({ acc: { name: "x" }, billing: s }, []), /\n▰▰▰▰▰▰ Free 300G \/ 200G\n/); // 账单为 0 时不标 ‼
    // 截止时间按手机本地时间显示，取所有行中最晚的 usage_end
    const end = new Date(2026, 10, 10, 13, 0).getTime() / 1000;
    s = ctx.summarizeBilling([{ ...row("Oregon", 1, 0), usage_end: String(end) }, { ...row("Iowa", 1, 0), usage_end: String(end - 3600) }]);
    assert.match(ctx.renderAccount({ acc: { name: "x" }, billing: s }, []), /^▸ x · thru 11-10 13:00\n[^]*\n▰▱▱▱▱▱ Free 2\.00G \/ 200G\n/);
    // 本月还没有账单数据：LEFT JOIN 返回一行全空，显示「暂无账单」而不是 0G
    s = ctx.summarizeBilling([{ service: null, sku: null, unit: null, qty: null, cost: null, free_credit: null, other_credit: null, currency: null, usage_end: null }]);
    assert.strictEqual(s.usageEnd, 0);
    const empty = ctx.renderAccount({ acc: { name: "x" }, billing: s }, []);
    assert.match(empty, /\nTraffic: 本月暂无账单$/);
    assert.doesNotMatch(empty, /Free|Paid|thru/);
    // 只有其他服务的记录（三类服务都没有）：有截止时间，流量为 0
    s = ctx.summarizeBilling([{ service: null, usage_end: String(end) }]);
    assert.match(ctx.renderAccount({ acc: { name: "x" }, billing: s }, []), /^▸ x · thru 11-10 13:00\n[^]*\n▱▱▱▱▱▱ Free 0G \/ 200G\nPaid 0G · \$0\.00$/);
    // 一个区域 250、另一个 50，有费用 → 只有超出的 50 收费
    s = ctx.summarizeBilling([row("Oregon", 250, 4.25), row("Iowa", 50, 0)]);
    assert.deepStrictEqual([s.stdOverGiB, s.freeGiB, s.paidGiB, s.paidCost], [50, 250, 50, 4.25]);
    // 每个区域都没超过 200，但账单有费用 → 按合计算超额
    s = ctx.summarizeBilling([row("Oregon", 150, 5), row("Iowa", 150, 3.5)]);
    assert.deepStrictEqual([s.freeGiB, s.paidGiB, s.paidCost], [200, 100, 8.5]);
    // 没超过 200 但账单有费用 → 费用不能丢
    s = ctx.summarizeBilling([row("Oregon", 120, 1.2)]);
    assert.deepStrictEqual([s.stdOverGiB, s.freeGiB, s.paidGiB, s.paidCost], [0, 120, 0, 1.2]);
    console.log("✓ 标准层出站按账单判断是否收费");

    // 进度条：有用量至少 1 格、四舍五入、超额末格为 ‼、数据缺失全空
    assert.strictEqual(ctx.bar(1, 1000, false), "▰▱▱▱▱▱");
    assert.strictEqual(ctx.bar(640, 1000, false), "▰▰▰▰▱▱");
    assert.strictEqual(ctx.bar(1000, 1000, false), "▰▰▰▰▰▰");
    assert.strictEqual(ctx.bar(1200, 1000, true), "▰▰▰▰▰‼");
    assert.strictEqual(ctx.bar(null, 1000, false), "▱▱▱▱▱▱");

    // 用量为 0 的 API 也显示，进度条全空
    const zeroQuota = { "vision.googleapis.com/document_text_detection_requests": 0, "translate.googleapis.com/default": 0 };
    assert.strictEqual(ctx.renderAccount({ acc: { name: "x" }, quota: zeroQuota }, []), "▸ x\n▱▱▱▱▱▱ Vision 0 / 1,000\n▱▱▱▱▱▱ Translate 0 / 500K");
    const someQuota = { ...zeroQuota, "translate.googleapis.com/default": 312000 };
    assert.strictEqual(ctx.renderAccount({ acc: { name: "x" }, quota: someQuota }, []), "▸ x\n▱▱▱▱▱▱ Vision 0 / 1,000\n▰▰▰▰▱▱ Translate 312K / 500K");

    // 图标颜色：正常绿；用量 ≥ 80% / 有费用 / 数据缺失橙；超额 / 认证失败红
    s = ctx.summarizeBilling([row("Oregon", 10, 0)]);
    const acc = { name: "x" };
    assert.strictEqual(ctx.panelLevel([{ acc, quota: someQuota, billing: s }]), 0);
    assert.strictEqual(ctx.panelLevel([{ acc, quota: { ...zeroQuota, "translate.googleapis.com/default": 400000 }, billing: s }]), 1);
    assert.strictEqual(ctx.panelLevel([{ acc, quota: someQuota, billing: ctx.summarizeBilling([row("Oregon", 120, 1.2)]) }]), 1);
    assert.strictEqual(ctx.panelLevel([{ acc, quota: someQuota, billingError: new Error("x") }]), 1);
    assert.strictEqual(ctx.panelLevel([{ acc, quota: { ...zeroQuota, "translate.googleapis.com/default": 600000 }, billing: s }]), 2);
    assert.strictEqual(ctx.panelLevel([{ acc, error: new Error("x") }]), 2);

    // 最长的行（超额 + 7 位数字）也不超过面板宽度
    const longest = ctx.renderAccount({ acc: { name: "account-name" }, quota: { "vision.googleapis.com/document_text_detection_requests": 1234567, "translate.googleapis.com/default": 123456789 } }, []);
    for (const line of longest.split("\n")) assert.ok(width(line) <= PANEL_WIDTH, `行过长(${width(line)}): ${line}`);
    console.log("✓ 进度条、零用量显示、图标状态色");
  }

  // 3c. 时间预算用完后不再发请求，直接报超时
  {
    const { ctx } = await run({ accounts: [], routes: [] });
    assert.ok(ctx.httpTimeout() <= 20 && ctx.httpTimeout() >= 1);
    const D = vm.runInContext("Date", ctx); // 脚本运行在独立的上下文里，有自己的 Date
    const realNow = D.now;
    D.now = () => realNow() + 60000;
    try {
      assert.throws(() => ctx.httpTimeout(), /超时/);
    } finally {
      D.now = realNow;
    }
    console.log("✓ 时间预算");
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
