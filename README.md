# surge-gcp-usage

用一个 Surge 面板脚本，分账号查看多个 GCP 账号的本月用量。

```
GCP · $0.75 · 13:41
账号：main
识图：▰▱▱▱▱▱ 19 / 1K · 1%
翻译：▰▱▱▱▱▱ 5.8K / 500K · 1%
费用：识图 $0.75
流量：15.9G
  免费：▰▱▱▱▱▱ 14.6G / 200G · 7%
  收费：0.01G · $0.0004
  账单截至 11-10 13:00

账号：alt
...

⚠ 用量：无权限（alt）
```

- 标题：本月所有账号的费用合计（收费流量 + 识图 / 翻译净费用），只在 ≥ $0.01 时显示，后面是刷新时间。
- 每个账号以「账号：名称」开头。
- 标签都是两个汉字加全角冒号（识图、翻译、流量、免费、收费），在系统字体里宽度完全相同，所以紧跟在标签后面的进度条自然对齐，不需要补空格。改标签时要保持这个规则。
- 有额度的行格式为「标签：进度条 已用 / 额度 · 百分比」：
  - 进度条 6 格（`BAR_CELLS`）：▰ 已用、▱ 剩余。格数和百分比都向下取整，有用量时至少 1 格、至少 1%。
  - 用量达到或超过额度时，进度条填满，行尾的百分比换成「‼」。数据缺失时进度条全空，不显示百分比。
  - 进度条以 ▰ 开头时，整段每格等宽；全空（▱▱▱▱▱▱）时系统会换一种回退字体，整段会宽一些，后面的数字会稍微错开。
- 「识图」是 Vision 文档文字识别，「翻译」是 Translate，口径见下方「免费额度配置」。两者都用英文缩写（如 19 / 1K、4.3K / 312K / 1.2M，不足 10 时保留一位小数），由 `FREE_QUOTA` 里的 `compact` 控制。用量为 0 时也显示。不显示调用次数；只有 `basis` 设为 `calls` 或没设额度时，才会查询并显示「N 次」。
- 「费用」这一行是识图 / 翻译的净费用，只在金额 ≥ $0.01 时才显示。
- 流量是一组，「流量」是实时数据，缩进的几行来自账单：
  - 「流量」：本月发往外部网络（互联网）的出站总量，来自 Cloud Monitoring，近实时。它包括对等互连等收费出站，不分网络层级，所以不和 200G 额度比较，只显示数字。这个数是按采样估算的，和账单会有几个百分点的误差。只统计 `projects` 里列出的项目（留空时是服务账号所属项目）。
  - 「免费」：本月标准层互联网出站流量（所有区域合计） / 每月 200 GiB 免费额度。单位 G 即 GiB。账单确认有超额收费时，显示「‼」。入站等其他免费流量不显示。
  - 「收费」：本月收费流量 · 这部分流量的费用，包括对等互连出站和标准出站的超额部分。
  - 「账单截至」：这个账号的账单统计截止时间，只对免费和收费有效，表示这个时间点之前的用量已经计入。它取本月账单表所有服务中最新的 `usage_end_time`，不是数据导出时间（`export_time`），按手机本地时间显示。每个账号单独显示，因为各账号的导出进度可能不同。截止时间之后的几个小时，账单数据可能还会补进来。流量比免费加收费多出来的部分，大致就是截止时间之后的流量。
  - 本月账单表里还没有任何数据时（月初，或刚开启导出、还在回填），流量下面显示「免费 / 收费：本月暂无账单」，不显示 0G。账单查询失败时，流量下面不显示任何行，原因见底部提示。
- 面板图标是 SF Symbol `cloud.fill`，颜色表示整体状态：绿色正常；橙色表示有用量达到额度的 80%（`WARN_RATIO`）、本月已产生费用，或部分数据没取到；红色表示超额或认证失败。
- 多个账号出现相同的问题时，合并成底部一行提示。
- 一行大约能放 17.4em 宽的文字（系统字体实测）。测试会按实测字宽估算每一行，检查有没有超宽。

> **部署或新增账号**：按 [`docs/SETUP.md`](docs/SETUP.md) 一步步操作。这份手册是写给 Agent 用来引导用户的，每一步都有预期输出、分支判断和故障排查。Agent 的工作规则见 [`AGENTS.md`](AGENTS.md)。

## 数据来源

| 显示项 | 数据来源 | 时效 |
|---|---|---|
| Vision / Translate 已用量 | Cloud Monitoring `serviceruntime.googleapis.com/quota/rate/net_usage`（`basis: "calls"` 时改用 `api/request_count`） | 近实时 |
| 流量（外部出站总量） | Cloud Monitoring `networking.googleapis.com/vm_flow/egress_bytes_count`，`remote_location_type="EXTERNAL"` | 近实时（采样估算） |
| Vision / Translate 计费量与净费用 | BigQuery 账单导出（标准使用费用） | 延迟数小时 |
| Compute Engine 免费/收费流量 | BigQuery 账单导出，按 SKU 汇总 | 延迟数小时 |

Google 没有公开 API 能直接读取控制台的「账单报表」。Cloud Billing API 只能查账号信息和价目表，Budget API 只能查预算。所以按 SKU 统计用量，只能通过 BigQuery 账单导出来查。

认证用的是每个账号各自的只读服务账号：角色为 `monitoring.viewer`、`bigquery.jobUser` 和 `bigquery.dataViewer`，密钥为 JSON 格式。Surge 没有 WebCrypto，所以脚本用纯 JS（BigInt）实现 RS256 签名，换来的 token 缓存约 1 小时。

## 免费额度配置

在 `gcp-usage.js` 开头修改 `FREE_QUOTA`。它在 `<config>` 区块之外，重新安装时不会被覆盖：

```js
const FREE_QUOTA = {
  // 只统计文档文字识别（DOCUMENT_TEXT_DETECTION），每个功能每月前 1,000 单位免费
  vision: { limit: 1000, unit: "", basis: "quota", quotaMetric: "vision.googleapis.com/document_text_detection_requests" },
  // 每月前 50 万字符免费，包括语言检测
  translate: { limit: 500000, unit: "", compact: true, basis: "quota", quotaMetric: "translate.googleapis.com/default" },
};
```

`basis` 决定「已用」这个数从哪里来：

| 取值 | 含义 | 时效 |
|---|---|---|
| `quota` | 读取 Cloud Monitoring 里 `serviceruntime.googleapis.com/quota/rate/net_usage` 这项指标中，由 `quotaMetric` 指定的那个配额的用量 | 近实时 |
| `calls` | 直接用 API 调用次数 | 近实时 |
| `billing` | 用账单里的计费量 | 延迟数小时 |

我在真实项目里查到的配额指标：

| 配额指标 | 计量单位 |
|---|---|
| `translate.googleapis.com/default` | 发送到通用模型的字符数（v2/v3），`translateText` 和 `detectLanguage` 都计入，空格也算 |
| `translate.googleapis.com/default_requests_legacy` | 请求数 |
| `vision.googleapis.com/<功能>_requests` | 各功能的使用单位数，例如 `document_text_detection_requests` |
| `vision.googleapis.com/default_requests` | 请求数 |

说明：
- 官方文档没有给出「配额指标 ID」和「配额名称」的对应关系。上表的计量单位是根据数值推断的：平均每次请求约 80 个字符，并且另有一项明显是请求数。
- 想确认的话，可以在 Cloud Shell 执行：`gcloud alpha services quota list --service=translate.googleapis.com --consumer=projects/<项目ID>`

## 流量分类规则

只统计 Compute Engine 中单位为 GiB 的数据传输类 SKU。虚拟机核心、内存、License 等不计入。

| SKU（示例） | 归类 |
|---|---|
| `Network Standard Data Transfer Out to Internet from Oregon` | 免费。标准层每月 200 GiB 免费；账单上产生了费用时，超出部分计入收费（见下方说明） |
| `Network Standard Internet Data Transfer In to Oregon` | 免费（入站） |
| `Network Data Transfer In via Carrier Peering Network - Americas Based` | 免费（入站） |
| `Network Data Transfer In from Google Services from Americas to Americas` | 免费（入站） |
| `Network Data Transfer to Google Services from Americas to Americas` | 按账单判断：扣除免费层抵扣后费用为 0 就算免费 |
| `Network Data Transfer Out via Carrier Peering Network - Americas Based` | **收费**。这是发往 CDN Interconnect 合作伙伴的出站流量（例如 Cloudflare），不享受标准层的 200 GiB 免费额度 |
| 其他出站 SKU | 扣除免费层抵扣后仍有费用的算收费，否则算免费 |

标准层出站是否收费以账单为准：
- 账单上这类 SKU 的费用为 0 时，全部算免费，即使几个区域合计超过了 200 GiB。
- 账单上有费用时，超额量先按每个区域（每个 SKU 对应一个区域）各 200 GiB 计算；每个区域都没超过时，再按全部区域合计计算。
- 「免费：… xG / 200G」里的 x 是所有区域的合计。x 超过 200 但账单为 0 时，不标「‼」。
- 200 GiB 是按区域算还是按结算账号合计，我没能在官方定价页上确认，所以没有把其中一种写死。

金额的含义：
- 「收费」后面的金额：原价减去免费层抵扣（`FREE_TIER`），不扣赠金和促销抵扣，表示这部分流量本身的价格。
- 「费用」里识图 / 翻译的金额：扣掉所有抵扣后的净费用，不足 $0.01 时不显示。

## 每次刷新的请求与费用

以下按「一个账号刷新一次」计算。每个结算账号的免费额度各自独立。

| 请求 | 频率 | 计费 |
|---|---|---|
| `oauth2.googleapis.com/token` | 约 55 分钟一次，其余时间用缓存；缓存的 token 被拒绝（HTTP 401）时会重新签发并重试一次 | 免费 |
| Monitoring `timeSeries.list` | 每个项目 2 次：配额用量，每个配额指标返回 1 条时间序列（实测约 5 条）；外部出站，汇总成 1 条。`basis: "calls"` 时再加 1 次调用次数查询（2 条） | 每个结算账号每月前 100 万条免费，超出部分 $0.50/百万条 |
| BigQuery `jobs.query` | 1 次 | 每月前 1 TiB 免费。每次查询最少按 10 MB 计，而且通配查询不会命中结果缓存 |

账单导出本身免费，导出表的存储也在 BigQuery 每月 10 GiB 的免费额度内。部署手册会把账单表设为只保留 90 天的分区，这样存储量和每次查询的扫描量都不会一直增长。每天刷新一次的话，一个月约 300 MB 查询量、180 条左右时间序列，都远低于免费额度。

脚本给自己留了 50 秒的总时间预算（Surge 里脚本的 `timeout=60`）：单次请求最多等 20 秒，BigQuery 查询没跑完时每轮再等 10 秒，剩余时间不够就放弃并显示「请求超时」。

面板上的错误会被截短。完整的错误信息写在 Surge 的脚本日志里，以 `[gcp-usage]` 开头；`node test/live.js` 也会打印出来。

## 面板刷新机制

Surge 面板**不会在后台刷新**，脚本只在两种情况下运行：

- 点面板上的刷新按钮（`$trigger=button`）：每次都会重新查询。
- 打开面板所在页面时（`$trigger=auto-interval`）：iOS 是策略组选择页，Mac 是菜单栏的 Panels 子菜单。距上次刷新超过 `update-interval` 秒，才会自动刷新。

默认的 `update-interval=86400`，也就是自动刷新最多一天一次。

可选：在 `[Script]` 段加一行定时推送通知，比如每天 9 点：

```ini
gcp-usage-notify = type=cron,cronexp="0 9 * * *",script-path=js/gcp-usage.js,timeout=60,argument=notify=1
```

## 显示开关

在 Surge 配置 `[Script]` 段的 gcp-usage 那一行加上 `argument`，可以关掉进度条或百分比，多个参数用 `&` 连接：

```ini
gcp-usage = type=generic,timeout=60,script-path=js/gcp-usage.js,argument=bar=0&percent=0
```

| 参数 | 默认 | 作用 |
|---|---|---|
| `bar=0` | 显示 | 不显示进度条，数值紧跟在标签后面，仍然自然对齐 |
| `percent=0` | 显示 | 不显示行尾的百分比 |

额度用完或超额时，行尾的「‼」始终显示。效果示例：

```
默认               识图：▰▱▱▱▱▱ 19 / 1K · 1%
bar=0              识图：19 / 1K · 1%
percent=0          识图：▰▱▱▱▱▱ 19 / 1K
bar=0&percent=0    识图：19 / 1K
```

`install-surge.js` 发现配置里已经有 gcp-usage 这一行时不会改动它，所以重新安装不会覆盖这里的参数。定时通知那一行有自己的 `argument`，需要的话同样可以加，例如 `argument=notify=1&bar=0`。

## 注意

- **调用次数和计费量不是一回事**：
  - Monitoring 统计的是请求数，失败的请求也算在内。
  - Vision 按「图片数 × 功能数」计费，每个功能每月前 1000 个单位免费。
  - Translate 按字符计费。
- 账单月按太平洋时间划分，和控制台报表一致。调用次数也从太平洋时间当月 1 日 0 点开始统计。
- 如果密钥泄露，影响仅限于读取对应项目的监控数据和 BigQuery 数据。撤销方法：在 IAM → 服务账号 → `surge-usage` → 密钥里删除对应密钥。

## 开发与测试

```bash
node test/harness.js   # 离线测试：RS256 签名与 Node crypto 一致、多账号流程、流量分类、部分失败显示、token 缓存与失效重试、太平洋时间账单月
node test/tools.js     # 离线测试：终端断行修复、命令行参数解析、Surge 配置行登记
node test/live.js      # 读取 accounts.local.json，用真实接口跑一次，不修改任何文件
```

修改 `gcp-usage.js` 后，要重新运行 `node scripts/install-surge.js --conf <配置文件>`，Surge 里的脚本才会更新。开发约束见 `AGENTS.md`。
