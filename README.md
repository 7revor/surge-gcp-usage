# surge-gcp-usage

用一个 Surge 面板脚本，分账号查看多个 GCP 账号的本月用量。

```
GCP 用量 · 11月 · 13:35
▸ main
Vision 20 / 1,000 次
Translate 84 次 · 12.3万 / 50万 字符
免费流量 29.90 GiB（出站 14.59/200）
收费流量 0.01 GiB（Carrier Peering）

▸ alt
...

⚠ 调用次数：无权限 (403)（alt）
账单截至 11-10 13:00
```

- 面板图标使用 Surge 的 `info` 样式。
- 多个账号出现相同的问题时，合并成底部一行提示。
- 「账单截至」显示所有账号中最早的那个账单导出时间。

> **部署或新增账号**：按 [`docs/SETUP.md`](docs/SETUP.md) 一步步操作。这份手册是写给 Agent 用来引导用户的，每一步都有预期输出、分支判断和故障排查。Agent 的工作规则见 [`AGENTS.md`](AGENTS.md)。

## 数据来源

| 显示项 | 数据来源 | 时效 |
|---|---|---|
| Vision / Translate 调用次数 | Cloud Monitoring `serviceruntime.googleapis.com/api/request_count` | 近实时 |
| Vision / Translate 计费量与净费用 | BigQuery 账单导出（标准使用费用） | 延迟数小时 |
| Compute Engine 免费/收费流量 | BigQuery 账单导出，按 SKU 汇总 | 延迟数小时 |

Google 没有公开 API 能直接读取控制台的「账单报表」。Cloud Billing API 只能查账号信息和价目表，Budget API 只能查预算。所以按 SKU 统计用量，只能通过 BigQuery 账单导出来查。

认证用的是每个账号各自的只读服务账号：角色为 `monitoring.viewer`、`bigquery.jobUser` 和 `bigquery.dataViewer`，密钥为 JSON 格式。Surge 没有 WebCrypto，所以脚本用纯 JS（BigInt）实现 RS256 签名，换来的 token 缓存约 1 小时。

## 免费额度配置

在 `gcp-usage.js` 开头修改 `FREE_QUOTA`。它在 `<config>` 区块之外，重新安装时不会被覆盖：

```js
const FREE_QUOTA = {
  vision: { limit: 1000, unit: "次", basis: "calls" },        // 每个功能每月前 1,000 单位免费，用调用次数近似
  translate: { limit: 500000, unit: "字符", basis: "billing" }, // 每月前 50 万字符免费，按账单计费字符数统计
};
```

- `basis: "calls"`：用 Monitoring 的调用次数和额度比较，数据是实时的。
- `basis: "billing"`：用账单里的计费量和额度比较，数据会延迟几个小时。账单数据还没到时，只显示「额度 50万 字符」。
- 用量超过额度时，会标记「‼超额」。

## 流量分类规则

只统计 Compute Engine 中单位为 GiB 的数据传输类 SKU。虚拟机核心、内存、License 等不计入。

| SKU（示例） | 归类 |
|---|---|
| `Network Standard Data Transfer Out to Internet from Oregon` | 免费。标准层每月 200 GiB 免费，超出部分计入收费 |
| `Network Standard Internet Data Transfer In to Oregon` | 免费（入站） |
| `Network Data Transfer In via Carrier Peering Network - Americas Based` | 免费（入站） |
| `Network Data Transfer In from Google Services from Americas to Americas` | 免费（入站） |
| `Network Data Transfer to Google Services from Americas to Americas` | 按账单判断：扣除免费层抵扣后费用为 0 就算免费 |
| `Network Data Transfer Out via Carrier Peering Network - Americas Based` | **收费**。这是发往 CDN Interconnect 合作伙伴的出站流量（例如 Cloudflare），不享受标准层的 200 GiB 免费额度 |
| 其他出站 SKU | 扣除免费层抵扣后仍有费用的算收费，否则算免费 |

金额的含义：
- 「收费流量」后面的金额：原价减去免费层抵扣（`FREE_TIER`），不扣赠金和促销抵扣，表示这部分流量本身的价格。
- Vision / Translate 后面的金额：扣掉所有抵扣后的净费用，为 0 时不显示。

## 每次刷新的请求与费用

以下按「一个账号刷新一次」计算。每个结算账号的免费额度各自独立。

| 请求 | 频率 | 计费 |
|---|---|---|
| `oauth2.googleapis.com/token` | 约 55 分钟一次，其余时间用缓存 | 免费 |
| Monitoring `timeSeries.list` | 每个项目 1 次，每次返回 2 条时间序列 | 每个结算账号每月前 100 万条免费，超出部分 $0.50/百万条 |
| BigQuery `jobs.query` | 1 次 | 每月前 1 TiB 免费。每次查询最少按 10 MB 计，而且通配查询不会命中结果缓存 |

账单导出本身免费，导出表的存储也在 BigQuery 每月 10 GiB 的免费额度内。每天刷新一次的话，一个月约 300 MB 查询量、60 条时间序列，都远低于免费额度。

## 面板刷新机制

Surge 面板**不会在后台刷新**，脚本只在两种情况下运行：

- 点面板上的刷新按钮（`$trigger=button`）：每次都会重新查询。
- 打开面板所在页面时（`$trigger=auto-interval`）：iOS 是策略组选择页，Mac 是菜单栏的 Panels 子菜单。距上次刷新超过 `update-interval` 秒，才会自动刷新。

默认的 `update-interval=86400`，也就是自动刷新最多一天一次。

可选：在 `[Script]` 段加一行定时推送通知，比如每天 9 点：

```ini
gcp-usage-notify = type=cron,cronexp="0 9 * * *",script-path=js/gcp-usage.js,timeout=60,argument=notify=1
```

## 注意

- **调用次数和计费量不是一回事**：
  - Monitoring 统计的是请求数，失败的请求也算在内。
  - Vision 按「图片数 × 功能数」计费，每个功能每月前 1000 个单位免费。
  - Translate 按字符计费。
- 账单月按太平洋时间划分，和控制台报表一致。调用次数也从太平洋时间当月 1 日 0 点开始统计。
- 如果密钥泄露，影响仅限于读取对应项目的监控数据和 BigQuery 数据。撤销方法：在 IAM → 服务账号 → `surge-usage` → 密钥里删除对应密钥。

## 开发与测试

```bash
node test/harness.js   # 离线测试：RS256 签名与 Node crypto 一致、多账号流程、流量分类、部分失败显示、太平洋时间账单月
node test/tools.js     # 离线测试：终端断行修复
node test/live.js      # 读取 accounts.local.json，用真实接口跑一次，不修改任何文件
```

修改 `gcp-usage.js` 后，要重新运行 `node scripts/install-surge.js --conf <配置文件>`，Surge 里的脚本才会更新。开发约束见 `AGENTS.md`。
