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

// 显示宽度，单位 em，按 macOS 系统字体 14pt 实测：ASCII 查表，汉字和全角标点按 1em（偏保守，实测汉字 0.99、
// 「：」约 0.5）。进度条：以 ▰ 开头时整段用同一种回退字体，每格 0.602；全是 ▱ 时换成另一种字体，每格 0.923。
// 依据：Mac 面板实测在「⚠️ 账单：导出表尚未生成（开启账单导」处折行，这一段实测 17.4em；同一段用本函数估算约 17.7em
const PANEL_WIDTH = 17.7;
const ASCII_EM = [
  271, 300, 467, 619, 619, 915, 701, 286, 371, 371, 461, 619, 286, 461, 286, 294, 619, 414, 593, 616, 633, 607, 626, 500,
  628, 626, 286, 286, 619, 619, 619, 502, 907, 658, 646, 705, 716, 585, 527, 736, 731, 257, 527, 638, 557, 863, 731, 761,
  605, 761, 643, 626, 447, 712, 565, 859, 658, 493, 651, 333, 294, 333, 619, 563, 489, 541, 604, 549, 604, 561, 336, 599,
  578, 236, 236, 518, 242, 859, 573, 580, 600, 599, 370, 513, 353, 573, 492, 725, 514, 493, 528, 371, 248, 371, 619,
];
const SYMBOL_EM = { "‼": 556, "·": 479, "✗": 798, "⚠": 1429, "…": 794, "\uFE0F": 0 };
function width(s) {
  let w = 0;
  for (const ch of s.replace(/[▰▱]+/g, (bar) => (bar[0] === "▰" ? "\u0001" : "\u0002").repeat(bar.length))) {
    const c = ch.charCodeAt(0);
    if (c === 1) w += 602;
    else if (c === 2) w += 923;
    else w += c >= 0x20 && c < 0x7f ? ASCII_EM[c - 0x20] : SYMBOL_EM[ch] !== undefined ? SYMBOL_EM[ch] : 1000;
  }
  return w / 1000;
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
        if (/vm_flow\/egress_bytes_count/.test(filter)) {
          assert.match(filter, /remote_location_type="EXTERNAL"/);
          assert.strictEqual(u.searchParams.get("aggregation.groupByFields"), "metric.labels.remote_location_type");
          const gib = 2 ** 30;
          const pt = (v) => ({ value: { int64Value: String(Math.round(v * gib)) } });
          return [200, { timeSeries: [{ metric: { labels: { remote_location_type: "EXTERNAL" } }, points: [pt(10.5), pt(5.4)] }] }];
        }
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
  assert.match(c, /账号：主号\n识图：▰▰▰▰▰▰ 1\.2K \/ 1K ‼\n/); // 只统计文档识别（label_detection 不计），超额时进度条填满、百分比换成 ‼；用 K 缩写；不显示调用次数
  assert.match(c, /\n翻译：▰▱▱▱▱▱ 5\.6K \/ 500K · 1%\n/); // 字符数来自配额指标，不用账单；有用量时至少 1 格、至少 1%
  // 流量是 Monitoring 的外部出站（多个点求和）；缩进的免费 / 收费和截止时间来自账单
  assert.match(c, /费用：识图 \$0\.75\n流量：15\.9G\n  免费：▰▱▱▱▱▱ 14\.6G \/ 200G · 7%\n  收费：0\.01G · \$0\.0004\n  账单截至 \d\d-\d\d \d\d:\d\d\n/); // 免费只算标准层出站；收费为对等互连
  assert.match(bqSql, /MAX\(usage_end_time\) AS usage_end FROM m\)/); // 截止时间取整张表，不限服务
  assert.match(bqSql, /LEFT JOIN g ON TRUE/);
  assert.match(c, /账号：副号\n识图：▱▱▱▱▱▱ \? \/ 1K\n翻译：▱▱▱▱▱▱ \? \/ 500K\n流量：\?\n/); // 数据缺失时进度条全空、不显示百分比
  assert.match(c, /流量：\?\n  免费：▰▰▰▰▰▰ 231G \/ 200G ‼\n  收费：30\.5G · \$2\.60\n  账单截至 /); // 标准出站超额计入收费
  assert.match(c, /\n\n⚠ 用量：无权限（副号）$/);
  assert.doesNotMatch(c, /thru/);
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
    assert.match(r2.result.content, /识图：▰▰▰▰▰▰ 1\.2K \/ 1K/);
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
    assert.match(r3.result.content, /识图：▰▰▰▰▰▰ 1\.2K \/ 1K/);
    assert.match(r3.result.content, /\n  免费：▰▱▱▱▱▱ 14\.6G \/ 200G · 7%/);
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
    assert.match(ctx.renderAccount({ acc: { name: "x" }, billing: s }, []), /\n  免费：▰▰▰▰▰▰ 300G \/ 200G · 150%\n/); // 账单为 0 时不标 ‼
    // 截止时间按手机本地时间显示，取所有行中最晚的 usage_end
    const end = new Date(2026, 10, 10, 13, 0).getTime() / 1000;
    s = ctx.summarizeBilling([{ ...row("Oregon", 1, 0), usage_end: String(end) }, { ...row("Iowa", 1, 0), usage_end: String(end - 3600) }]);
    assert.match(ctx.renderAccount({ acc: { name: "x" }, billing: s, trafficGiB: 2.5 }, []), /^账号：x\n[^]*\n流量：2\.50G\n  免费：▰▱▱▱▱▱ 2\.00G \/ 200G · 1%\n  收费：0G · \$0\.00\n  账单截至 11-10 13:00$/);
    // 本月还没有账单数据：LEFT JOIN 返回一行全空，显示「暂无账单」而不是 0G
    s = ctx.summarizeBilling([{ service: null, sku: null, unit: null, qty: null, cost: null, free_credit: null, other_credit: null, currency: null, usage_end: null }]);
    assert.strictEqual(s.usageEnd, 0);
    const empty = ctx.renderAccount({ acc: { name: "x" }, billing: s, trafficGiB: 5.68 }, []);
    assert.match(empty, /\n流量：5\.68G\n  免费 \/ 收费：本月暂无账单$/);
    assert.doesNotMatch(empty, /账单截至|G \/ 200G/);
    // 账单查询失败：流量下不显示免费 / 收费（问题在页脚提示）
    assert.match(ctx.renderAccount({ acc: { name: "x" }, billingError: new Error("x"), trafficGiB: 0 }, []), /\n流量：0G$/);
    // 只有其他服务的记录（三类服务都没有）：有截止时间，流量为 0
    s = ctx.summarizeBilling([{ service: null, usage_end: String(end) }]);
    assert.match(ctx.renderAccount({ acc: { name: "x" }, billing: s }, []), /\n  免费：▱▱▱▱▱▱ 0G \/ 200G · 0%\n  收费：0G · \$0\.00\n  账单截至 11-10 13:00$/);
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

    // 进度条 + 百分比：有用量至少 1 格、至少 1%；格数和百分比都向下取整；用完时填满并换成 ‼；数据缺失全空、无百分比
    assert.strictEqual(ctx.meter(1, 1000, "v", false), "▰▱▱▱▱▱ v · 1%");
    assert.strictEqual(ctx.meter(640, 1000, "v", false), "▰▰▰▱▱▱ v · 64%");
    assert.strictEqual(ctx.meter(999, 1000, "v", false), "▰▰▰▰▰▱ v · 99%");
    assert.strictEqual(ctx.meter(0, 1000, "v", false), "▱▱▱▱▱▱ v · 0%");
    assert.strictEqual(ctx.meter(1200, 1000, "v", true), "▰▰▰▰▰▰ v ‼");
    assert.strictEqual(ctx.meter(null, 1000, "v", false), "▱▱▱▱▱▱ v");
    // API 用量刚好等于额度也算用完
    assert.strictEqual(ctx.apiLine({ quota: { "vision.googleapis.com/document_text_detection_requests": 1000 } }, "vision", "识图"), "识图：▰▰▰▰▰▰ 1K / 1K ‼");

    // 用量为 0 的 API 也显示，进度条全空
    const zeroQuota = { "vision.googleapis.com/document_text_detection_requests": 0, "translate.googleapis.com/default": 0 };
    assert.strictEqual(ctx.renderAccount({ acc: { name: "x" }, quota: zeroQuota, trafficGiB: 0 }, []), "账号：x\n识图：▱▱▱▱▱▱ 0 / 1K · 0%\n翻译：▱▱▱▱▱▱ 0 / 500K · 0%\n流量：0G");
    const someQuota = { ...zeroQuota, "translate.googleapis.com/default": 312000 };
    assert.strictEqual(ctx.renderAccount({ acc: { name: "x" }, quota: someQuota, trafficGiB: 0 }, []), "账号：x\n识图：▱▱▱▱▱▱ 0 / 1K · 0%\n翻译：▰▰▰▱▱▱ 312K / 500K · 62%\n流量：0G");

    // 图标颜色：正常绿；用量 ≥ 80% / 有费用 / 数据缺失橙；超额 / 认证失败红
    s = ctx.summarizeBilling([row("Oregon", 10, 0)]);
    const acc = { name: "x" };
    assert.strictEqual(ctx.panelLevel([{ acc, quota: someQuota, billing: s }]), 0);
    assert.strictEqual(ctx.panelLevel([{ acc, quota: { ...zeroQuota, "translate.googleapis.com/default": 400000 }, billing: s }]), 1);
    assert.strictEqual(ctx.panelLevel([{ acc, quota: someQuota, billing: ctx.summarizeBilling([row("Oregon", 120, 1.2)]) }]), 1);
    assert.strictEqual(ctx.panelLevel([{ acc, quota: someQuota, billingError: new Error("x") }]), 1);
    assert.strictEqual(ctx.panelLevel([{ acc, quota: { ...zeroQuota, "translate.googleapis.com/default": 600000 }, billing: s }]), 2);
    assert.strictEqual(ctx.panelLevel([{ acc, error: new Error("x") }]), 2);

    // 最长的行也不超过面板宽度：识图 / 翻译各种用量（含超额、7 位数字），免费流量 0～400G（含超过 200G 但未收费），大额收费流量
    const fit = (text) => {
      for (const line of text.split("\n")) assert.ok(width(line) <= PANEL_WIDTH, `行过长(${width(line).toFixed(2)}): ${line}`);
    };
    for (const n of [0, 1, 9, 99, 999, 1000, 9949, 99499, 499999, 999999, 1234567, 123456789])
      fit(ctx.renderAccount({ acc: { name: "account-name" }, quota: { "vision.googleapis.com/document_text_detection_requests": n, "translate.googleapis.com/default": n }, trafficGiB: 1234.5 }, []));
    for (let g = 0; g <= 400; g += 0.01) {
      const billing = ctx.summarizeBilling([row("Oregon", g, 0)]);
      billing.usageEnd = end;
      fit(ctx.renderAccount({ acc: { name: "x" }, billing, trafficGiB: g }, []));
    }
    const big = ctx.summarizeBilling([row("Oregon", 1999, 299.99)]);
    big.usageEnd = end;
    fit(ctx.renderAccount({ acc: { name: "x" }, billing: big, trafficGiB: 9999 }, []));
    assert.match(ctx.renderAccount({ acc: { name: "x" }, trafficGiB: 99.97 }, []), /\n流量：100G$/); // 进位后不显示成 100.0G
    assert.match(ctx.renderAccount({ acc: { name: "x" }, trafficGiB: 9.996 }, []), /\n流量：10\.0G$/);
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
    assert.match(res.result.content, /账号：空\n✗ 服务账号密钥未配置/);
    console.log("✓ 未配置提示");
  }
  console.log("\n全部通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
