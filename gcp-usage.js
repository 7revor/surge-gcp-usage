/**
 * GCP 用量面板（Surge）
 *
 * - Vision / Translate 本月调用次数与配额用量（已用/免费额度）：Cloud Monitoring（近实时）
 * - Vision / Translate 净费用、Compute Engine 免费/收费流量：BigQuery 账单导出（延迟数小时）
 * - 多个 GCP 账号分开查询、分开显示
 *
 * 认证：服务账号 JSON 密钥，脚本内用纯 JS 实现 RS256 签 JWT 换 access token（缓存 ~1 小时）。
 *
 * 参数（$argument，可选）：notify=1 时额外推送通知（配合 cron 使用）
 */

// <config>
const ACCOUNTS = [
  {
    // 面板中显示的名字
    name: "主号",
    // 账单导出所在的 BigQuery 数据集：项目ID.数据集名
    billingDataset: "your-project-id.billing_export",
    // 统计 Vision/Translate 调用次数的项目；留空 = 服务账号所属项目
    projects: [],
    // 服务账号 JSON 密钥，原样粘贴整个对象
    key: {
      type: "service_account",
      project_id: "your-project-id",
      private_key_id: "",
      private_key: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
      client_email: "surge-usage@your-project-id.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
    },
  },
  // { name: "副号", billingDataset: "...", projects: [], key: { ... } },
];
// </config>

// 免费额度（每个结算账号每月），可按需修改：
//   limit  免费额度；unit  显示单位
//   basis  统计口径："quota" 按 quotaMetric 指定的配额用量（近实时）；"calls" 按 API 调用次数（近实时）；
//          "billing" 按账单计费量（延迟数小时）
const FREE_QUOTA = {
  // Vision：每个功能每月前 1,000 单位免费；这里只统计文档文字识别（DOCUMENT_TEXT_DETECTION）
  vision: { limit: 1000, unit: "", basis: "quota", quotaMetric: "vision.googleapis.com/document_text_detection_requests" },
  // Translate：每月前 50 万字符免费；配额「发送到通用模型的字符数」，含语言检测，不含 Translation LLM / 自定义模型
  translate: { limit: 500000, unit: "字符", basis: "quota", quotaMetric: "translate.googleapis.com/default" },
};
const STANDARD_FREE_GIB = 200; // 标准层互联网出站每月免费额度
const BILLING_TZ = "America/Los_Angeles"; // 账单月按太平洋时间划分

// 总时间预算：Surge 里脚本的 timeout=60，超时会被直接终止、面板上什么都不显示。
// 所有请求的超时都按剩余预算收紧，保证脚本能在被终止前把错误显示出来。
const TIME_BUDGET_MS = 50000;
const STARTED_AT = Date.now();
const timeLeft = () => TIME_BUDGET_MS - (Date.now() - STARTED_AT);

// ============================================================
// 主流程（入口在文件末尾，确保所有常量已初始化）
// ============================================================

async function main() {
  const now = new Date();
  const period = billingMonth(now);
  const blocks = await Promise.all(ACCOUNTS.map((acc) => queryAccount(acc, period, now).catch((e) => ({ acc, error: e }))));
  // 面板上的错误会被截短，完整内容写进 Surge 的脚本日志
  for (const b of blocks) {
    if (b.error) log(`${b.acc.name} 认证: ${fullErr(b.error)}`);
    if (b.monitorError) log(`${b.acc.name} 用量: ${fullErr(b.monitorError)}`);
    if (b.billingError) log(`${b.acc.name} 账单: ${fullErr(b.billingError)}`);
  }
  return {
    title: `GCP 用量 · ${period.label}月 · ${hhmm(now)}`,
    content: render(blocks),
    style: "info",
  };
}

async function queryAccount(acc, period, now) {
  const r = await queryWithToken(acc, period, now, await getAccessToken(acc.key));
  if (!isUnauthorized(r.monitorError) && !isUnauthorized(r.billingError)) return r;
  // 缓存的 token 已失效（例如服务账号被停用后又恢复）：丢弃缓存，重新签发后重试一次
  return queryWithToken(acc, period, now, await getAccessToken(acc.key, true));
}

function isUnauthorized(e) {
  return !!e && /HTTP 401/.test(errMsg(e));
}

async function queryWithToken(acc, period, now, token) {
  const projects = acc.projects && acc.projects.length ? acc.projects : [acc.key.project_id];
  const [mon, bill] = await Promise.all([
    Promise.all(
      projects.map((p) =>
        Promise.all([
          needCallCounts() ? apiRequestCounts(token, p, period.start, now) : {},
          quotaUsage(token, p, period.start, now),
        ])
      )
    )
      .then((list) => ({ ok: { counts: mergeCounts(list.map((x) => x[0])), quota: mergeCounts(list.map((x) => x[1])) } }))
      .catch((e) => ({ err: e })),
    queryBilling(token, acc, period.month)
      .then((rows) => ({ ok: summarizeBilling(rows) }))
      .catch((e) => ({ err: e })),
  ]);
  return {
    acc,
    counts: mon.ok && mon.ok.counts,
    quota: mon.ok && mon.ok.quota,
    monitorError: mon.err,
    billing: bill.ok,
    billingError: bill.err,
  };
}

// ============================================================
// Cloud Monitoring：API 调用次数
// ============================================================

const SERVICES = { vision: "vision.googleapis.com", translate: "translate.googleapis.com" };

/** 只有某个 API 按调用次数统计（basis: "calls"）或没设免费额度时，才需要查询调用次数 */
function needCallCounts() {
  return Object.keys(SERVICES).some((k) => !(FREE_QUOTA[k] && FREE_QUOTA[k].limit) || FREE_QUOTA[k].basis === "calls");
}

function apiRequestCounts(token, project, start, end) {
  const filter =
    'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api" AND ' +
    `resource.labels.service=one_of("${SERVICES.vision}","${SERVICES.translate}")`;
  return sumSeries(token, project, filter, "resource.labels.service", start, end);
}

/** 配额用量：Translate 字符数、Vision 各功能单位数，按 quota_metric 汇总 */
function quotaUsage(token, project, start, end) {
  const filter =
    'metric.type="serviceruntime.googleapis.com/quota/rate/net_usage" AND resource.type="consumer_quota" AND ' +
    `resource.labels.service=one_of("${SERVICES.vision}","${SERVICES.translate}")`;
  return sumSeries(token, project, filter, "metric.labels.quota_metric", start, end);
}

/** 对 [start, end] 区间求和，按 groupBy（如 resource.labels.service）分组 */
async function sumSeries(token, project, filter, groupBy, start, end) {
  const seconds = Math.max(60, Math.ceil((end - start) / 1000));
  const base = {
    filter,
    "interval.startTime": start.toISOString(),
    "interval.endTime": end.toISOString(),
    "aggregation.alignmentPeriod": seconds + "s",
    "aggregation.perSeriesAligner": "ALIGN_SUM",
    "aggregation.crossSeriesReducer": "REDUCE_SUM",
    "aggregation.groupByFields": groupBy,
  };
  const [kind, , label] = groupBy.split(".");
  const out = {};
  let pageToken = "";
  do {
    const q = Object.assign({}, base, pageToken ? { pageToken } : {});
    const res = await request("GET", `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${qs(q)}`, token);
    for (const ts of res.timeSeries || []) {
      const k = ts[kind] && ts[kind].labels && ts[kind].labels[label];
      let sum = 0;
      for (const pt of ts.points || []) sum += Number(pt.value.int64Value || pt.value.doubleValue || 0);
      out[k] = (out[k] || 0) + sum;
    }
    pageToken = res.nextPageToken || "";
  } while (pageToken);
  return out;
}

function mergeCounts(list) {
  const out = {};
  for (const c of list) for (const k in c) out[k] = (out[k] || 0) + c[k];
  return out;
}

// ============================================================
// BigQuery 账单导出
// ============================================================

async function queryBilling(token, acc, month) {
  if (!/^[\w-]+\.[\w]+$/.test(acc.billingDataset || "")) throw new Error("billingDataset 格式应为 项目ID.数据集");
  const sql = `
SELECT
  service.description AS service,
  sku.description AS sku,
  ANY_VALUE(usage.pricing_unit) AS unit,
  SUM(usage.amount_in_pricing_units) AS qty,
  SUM(cost) AS cost,
  SUM((SELECT IFNULL(SUM(c.amount), 0) FROM UNNEST(credits) c WHERE c.type = 'FREE_TIER')) AS free_credit,
  SUM((SELECT IFNULL(SUM(c.amount), 0) FROM UNNEST(credits) c WHERE IFNULL(c.type, '') != 'FREE_TIER')) AS other_credit,
  ANY_VALUE(currency) AS currency,
  MAX(export_time) AS export_time
FROM \`${acc.billingDataset}.gcp_billing_export_v1_*\`
WHERE invoice.month = '${month}'
  AND REGEXP_CONTAINS(service.description, r'(?i)compute engine|vision|translat')
GROUP BY service, sku`;
  const project = acc.billingDataset.split(".")[0];
  let res = await request("POST", `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`, token, {
    query: sql,
    useLegacySql: false,
    timeoutMs: 10000,
  });
  // 每轮最多等 10 秒；剩余时间不够再等一轮时就放弃
  while (!res.jobComplete && timeLeft() > 15000) {
    const ref = res.jobReference;
    const q = { timeoutMs: 10000 };
    if (ref.location) q.location = ref.location;
    res = await request("GET", `https://bigquery.googleapis.com/bigquery/v2/projects/${ref.projectId}/queries/${ref.jobId}?${qs(q)}`, token);
  }
  if (!res.jobComplete) throw new Error("BigQuery 查询超时");
  const names = res.schema.fields.map((f) => f.name);
  return (res.rows || []).map((r) => {
    const o = {};
    r.f.forEach((c, i) => (o[names[i]] = c.v));
    return o;
  });
}

/**
 * 流量分类规则：
 * - Carrier/Direct Peering、CDN Interconnect 出站 → 收费（不享受标准层 200 GiB 免费额度）
 * - 标准层互联网出站 → 免费；账单上产生了费用时，超出 200 GiB 的部分 → 收费
 *   （超额量先按区域各 200 GiB 算，算不出超额再按全部区域合计算）
 * - 入站 → 免费
 * - 其他（如发往 Google 服务）→ 扣除免费层抵扣后仍有费用则收费，否则免费
 */
function summarizeBilling(rows) {
  const s = {
    currency: "",
    exportTime: 0,
    vision: { qty: 0, unit: "", net: 0 },
    translate: { qty: 0, unit: "", net: 0 },
    freeGiB: 0,
    stdGiB: 0,
    stdOverGiB: 0,
    paidGiB: 0,
    paidCost: 0,
  };
  let stdCost = 0;
  let stdOverByRegion = 0; // 每个 SKU 对应一个区域
  for (const r of rows) {
    const qty = Number(r.qty) || 0;
    const cost = Number(r.cost) || 0;
    const freeCredit = Number(r.free_credit) || 0;
    const net = cost + freeCredit + (Number(r.other_credit) || 0);
    s.currency = s.currency || r.currency || "";
    s.exportTime = Math.max(s.exportTime, Number(r.export_time) || 0);

    if (/vision/i.test(r.service) || /translat/i.test(r.service)) {
      const t = /vision/i.test(r.service) ? s.vision : s.translate;
      t.qty += qty;
      t.unit = t.unit || r.unit || "";
      t.net += net;
      continue;
    }
    if (!/compute engine/i.test(r.service) || r.unit !== "gibibyte" || !/transfer|egress|ingress/i.test(r.sku)) continue;

    const sku = r.sku;
    const isOut = /\bout\b|egress/i.test(sku);
    if (/peering|interconnect/i.test(sku) && isOut) {
      addPaid(s, qty, cost + freeCredit);
    } else if (/standard/i.test(sku) && /internet/i.test(sku) && isOut) {
      s.stdGiB += qty;
      stdCost += cost + freeCredit;
      stdOverByRegion += Math.max(0, qty - STANDARD_FREE_GIB);
    } else if (/\bin\b|ingress/i.test(sku) && !isOut) {
      s.freeGiB += qty;
    } else if (cost + freeCredit > 1e-9) {
      addPaid(s, qty, cost + freeCredit);
    } else {
      s.freeGiB += qty;
    }
  }
  // 是否收费以账单为准：只有实际产生了费用，才把超出免费额度的部分算作收费。
  // 这样多个区域合计超过 200 GiB 但账单为 0 时不会误报，有费用时也不会漏掉。
  const stdPaid = stdCost > 1e-9;
  const stdOver = stdPaid ? stdOverByRegion || Math.max(0, s.stdGiB - STANDARD_FREE_GIB) : 0;
  s.stdOverGiB = stdOver;
  s.freeGiB += s.stdGiB - stdOver;
  if (stdPaid) addPaid(s, stdOver, stdCost);
  return s;
}

function addPaid(s, gib, cost) {
  s.paidGiB += gib;
  s.paidCost += cost;
}

// ============================================================
// 渲染
// ============================================================

// 面板一行约 18.5 个汉字宽（ASCII 约 0.55 个汉字宽），每行尽量控制在此以内
function render(blocks) {
  const issues = [];
  const body = blocks.map((b) => renderAccount(b, issues)).join("\n\n");

  const footer = [];
  const groups = [];
  for (const it of issues) {
    const g = groups.find((x) => x.scope === it.scope && x.msg === it.msg);
    if (g) g.names.push(it.name);
    else groups.push({ scope: it.scope, msg: it.msg, names: [it.name] });
  }
  for (const g of groups) {
    let who = "";
    if (blocks.length > 1) who = g.names.length === blocks.length ? "（全部账号）" : `（${g.names.join("、")}）`;
    footer.push(`⚠ ${g.scope}：${g.msg}${who}`);
  }
  const times = blocks.map((b) => b.billing && b.billing.exportTime).filter(Boolean);
  if (times.length) footer.push(`账单截至 ${mmddhhmm(new Date(Math.min.apply(null, times) * 1000))}`);

  return footer.length ? body + "\n\n" + footer.join("\n") : body;
}

function renderAccount(b, issues) {
  const name = b.acc.name;
  const lines = [`▸ ${name}`];
  if (b.error) return lines.concat(`✗ ${shortErr(b.error)}`).join("\n");
  if (b.monitorError) issues.push({ scope: "用量", msg: shortErr(b.monitorError), name });
  if (b.billingError) issues.push({ scope: "账单", msg: shortErr(b.billingError), name });

  lines.push(apiLine(b, "vision", "Vision"));
  lines.push(apiLine(b, "translate", "Translate"));

  const bill = b.billing;
  if (bill) {
    // Vision / Translate 净费用：只在 ≥ $0.01 时显示
    const costs = [];
    if (bill.vision.net >= 0.01) costs.push(`Vision ${money(bill.vision.net, bill.currency)}`);
    if (bill.translate.net >= 0.01) costs.push(`Translate ${money(bill.translate.net, bill.currency)}`);
    if (costs.length) lines.push(`Cost ${costs.join(" · ")}`);

    // Free：标准层出站 / 免费额度，账单确认有超额收费时行首加 ‼；Paid：收费流量 / 流量费用
    const free = `Traffic Free ${fmtG(bill.stdGiB)}/${STANDARD_FREE_GIB} GiB`;
    lines.push(bill.stdOverGiB > 0 ? "‼ " + free : free);
    lines.push(`Traffic Paid ${gib(bill.paidGiB)}/${money(bill.paidCost, bill.currency)}`);
  }
  return lines.join("\n");
}

/** 例：「Vision 19/1,000」「Translate 5,633/50万字符」，超额时行首加 ‼；没设额度时显示「Vision 20 次」 */
function apiLine(b, key, label) {
  const q = FREE_QUOTA[key] || {};
  const callsN = b.monitorError ? null : (b.counts || {})[SERVICES[key]] || 0;
  if (!q.limit) return `${label} ${callsN === null ? "?" : fmtInt(callsN)} 次`;

  let used = null;
  if (q.basis === "quota") {
    if (b.quota) used = b.quota[q.quotaMetric] || 0;
  } else if (q.basis === "billing") {
    if (b.billing) used = b.billing[key].qty;
  } else {
    used = callsN;
  }
  const line = `${label} ${used === null ? "?" : fmtBig(used)}/${fmtBig(q.limit)}${q.unit || ""}`;
  return used !== null && used > q.limit ? "‼ " + line : line;
}

function shortErr(e) {
  const m = errMsg(e);
  if (/does not match any table/.test(m)) return "数据未就绪";
  if (/密钥未配置/.test(m)) return "服务账号密钥未配置";
  if (/invalid_grant|Invalid JWT|HTTP 401/i.test(m)) return "密钥无效";
  if (/HTTP 403/.test(m)) return "无权限";
  if (/timed? ?out|超时/i.test(m)) return "请求超时";
  return m.length > 16 ? m.slice(0, 16) + "…" : m;
}

function money(v, cur) {
  cur = cur || "USD"; // 账单尚无数据时没有币种，按美元显示
  const sym = { USD: "$", CNY: "¥", HKD: "HK$", EUR: "€", JPY: "¥" }[cur];
  const n = Math.abs(v) < 0.005 && v !== 0 ? v.toFixed(4) : v.toFixed(2);
  return sym ? sym + n : `${n} ${cur || ""}`.trim();
}

// 按数量级缩短小数：<10 两位，<100 一位，其余取整
const fmtG = (v) => (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0));
const gib = (v) => `${fmtG(v)} GiB`;
/** ≥ 1 万时用「万」，例：1,000 / 12.3万 / 50万 */
function fmtBig(v) {
  if (v < 10000) return Number.isInteger(v) ? fmtInt(v) : v.toFixed(2);
  return (v / 10000).toFixed(1).replace(/\.0$/, "") + "万";
}
function fmtInt(v) {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ============================================================
// 时间：账单月（太平洋时间）
// ============================================================

function billingMonth(now) {
  const p = tzParts(now);
  const y = p.year;
  const m = p.month;
  const guess = Date.UTC(y, m - 1, 1);
  const q = tzParts(new Date(guess));
  const offset = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - guess;
  return { start: new Date(guess - offset), month: `${y}${String(m).padStart(2, "0")}`, label: m };
}

function tzParts(date) {
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: BILLING_TZ,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    const o = {};
    for (const part of f.formatToParts(date)) if (part.type !== "literal") o[part.type] = Number(part.value) % (part.type === "hour" ? 24 : Infinity);
    return o;
  } catch (e) {
    // 无 Intl 时区支持：按 UTC-8 近似
    const d = new Date(date.getTime() - 8 * 3600e3);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }
}

const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const mmddhhmm = (d) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm(d)}`;

// ============================================================
// HTTP
// ============================================================

function request(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const opts = { url, timeout: httpTimeout(), headers: { Authorization: "Bearer " + token } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const fn = method === "POST" ? $httpClient.post : $httpClient.get;
    fn.call($httpClient, opts, (err, resp, data) => handleResp(err, resp, data, resolve, reject));
  });
}

/** 单次请求的超时（秒）：最多 20 秒，且不超过剩余的总时间预算 */
function httpTimeout() {
  const left = Math.floor(timeLeft() / 1000);
  if (left < 1) throw new Error("请求超时");
  return Math.min(20, left);
}

function handleResp(err, resp, data, resolve, reject) {
  if (err || !resp) return reject(new Error(String(err || "无响应")));
  let json = null;
  try {
    json = JSON.parse(data);
  } catch (e) {}
  const status = resp.status || resp.statusCode;
  if (status >= 400) {
    const msg = (json && ((json.error && json.error.message) || json.error_description || json.error)) || String(data).slice(0, 200);
    return reject(new Error(`HTTP ${status}: ${msg}`));
  }
  resolve(json !== null ? json : data);
}

function qs(obj) {
  return Object.keys(obj)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]))
    .join("&");
}

function parseArgs(s) {
  const o = {};
  for (const kv of s.split("&")) {
    if (!kv) continue;
    const i = kv.indexOf("=");
    o[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? "1" : decodeURIComponent(kv.slice(i + 1));
  }
  o.notify = o.notify === "1" || o.notify === "true";
  return o;
}

function fullErr(e) {
  return String((e && e.message) || e);
}

function errMsg(e) {
  return fullErr(e).slice(0, 160);
}

function log(msg) {
  if (typeof console !== "undefined") console.log("[gcp-usage] " + msg);
}

// ============================================================
// 服务账号认证（JWT RS256）
// ============================================================

/** fresh=true 时跳过缓存，重新签发并覆盖缓存 */
async function getAccessToken(key, fresh) {
  if (!key || !key.client_email || !/BEGIN/.test(key.private_key || "")) throw new Error("服务账号密钥未配置");
  const cacheKey = "gcp_usage.token." + key.client_email;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!fresh) {
    try {
      const c = JSON.parse($persistentStore.read(cacheKey) || "null");
      if (c && c.exp - 300 > nowSec) return c.token;
    } catch (e) {}
  }

  const tokenUri = key.token_uri || "https://oauth2.googleapis.com/token";
  const header = b64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id })));
  const claims = b64url(
    utf8(
      JSON.stringify({
        iss: key.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: tokenUri,
        iat: nowSec,
        exp: nowSec + 3600,
      })
    )
  );
  const unsigned = header + "." + claims;
  const jwt = unsigned + "." + rs256Sign(parseRsaPrivateKey(key.private_key), unsigned);

  const res = await new Promise((resolve, reject) => {
    $httpClient.post(
      {
        url: tokenUri,
        timeout: httpTimeout(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt,
      },
      (err, resp, data) => handleResp(err, resp, data, resolve, reject)
    );
  });
  if (!res || !res.access_token) throw new Error("获取 access token 失败");
  $persistentStore.write(JSON.stringify({ token: res.access_token, exp: nowSec + (res.expires_in || 3600) }), cacheKey);
  return res.access_token;
}

// ---------- RSA（PKCS#1 v1.5 + SHA-256，CRT 加速） ----------

function rs256Sign(k, data) {
  const hash = bytesToHex(sha256(utf8(data)));
  const digestInfo = "3031300d060960864801650304020105000420" + hash;
  const len = k.byteLength;
  const em = "0001" + "ff".repeat(len - 3 - digestInfo.length / 2) + "00" + digestInfo;
  const m = BigInt("0x" + em);
  const m1 = modPow(m % k.p, k.dp, k.p);
  const m2 = modPow(m % k.q, k.dq, k.q);
  let h = ((m1 - m2) * k.qi) % k.p;
  if (h < 0n) h += k.p;
  const s = m2 + h * k.q;
  return b64url(hexToBytes(s.toString(16).padStart(len * 2, "0")));
}

function modPow(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    e >>= 1n;
    if (e > 0n) b = (b * b) % mod;
  }
  return r;
}

function parseRsaPrivateKey(pem) {
  const der = b64decode(pem.replace(/-----[^-]+-----/g, ""));
  let seq = derRead(der, 0);
  let p = derRead(der, seq.start).end; // version
  const el = derRead(der, p);
  if (el.tag === 0x30) {
    // PKCS#8: AlgorithmIdentifier + OCTET STRING(RSAPrivateKey)
    const oct = derRead(der, el.end);
    seq = derRead(der, oct.start);
    p = derRead(der, seq.start).end;
  }
  const ints = [];
  while (ints.length < 8) {
    const e = derRead(der, p);
    ints.push(BigInt("0x" + (bytesToHex(der.subarray(e.start, e.end)) || "0")));
    p = e.end;
  }
  const [n, , , P, Q, dp, dq, qi] = ints;
  return { byteLength: (n.toString(16).length + 1) >> 1, p: P, q: Q, dp, dq, qi };
}

function derRead(bytes, pos) {
  const tag = bytes[pos];
  let len = bytes[pos + 1];
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[p++];
  }
  return { tag, start: p, end: p + len };
}

// ---------- SHA-256 ----------

const SHA256_K = (() => {
  const k = [];
  for (let n = 2, c = 0; c < 64; n++) {
    let prime = true;
    for (let i = 2; i * i <= n; i++) if (n % i === 0) prime = false;
    if (prime) {
      k.push((Math.cbrt(n) % 1) * 4294967296 >>> 0);
      c++;
    }
  }
  return k;
})();
const SHA256_H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

function sha256(msg) {
  const l = msg.length;
  const total = ((l + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor((l * 8) / 4294967296));
  dv.setUint32(total - 4, (l * 8) >>> 0);
  const h = SHA256_H.slice();
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  h.forEach((v, i) => odv.setUint32(i * 4, v));
  return out;
}

// ---------- 编码 ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64decode(str) {
  const s = str.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array((s.length * 3) >> 2);
  let buf = 0;
  let bits = 0;
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    buf = ((buf << 6) | B64.indexOf(s[i])) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, j);
}

function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) s += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) s += B64[n & 63];
  }
  return s.replace(/\+/g, "-").replace(/\//g, "_");
}

function utf8(str) {
  const s = unescape(encodeURIComponent(str));
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return s;
}

function hexToBytes(hex) {
  const a = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}

// ============================================================
// 入口
// ============================================================

const ARGS = parseArgs(typeof $argument === "string" ? $argument : "");

main()
  .then((panel) => {
    if (ARGS.notify) $notification.post(panel.title, "", panel.content);
    $done(panel);
  })
  .catch((e) => {
    $done({ title: "GCP 用量", content: "✗ " + errMsg(e), style: "info" });
  });
