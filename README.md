# surge-gcp-usage

用一个 Surge 面板脚本查询多个 GCP 账号的本月用量：

| 项目 | 数据来源 | 时效 |
|---|---|---|
| Vision / Translate 调用次数 | Cloud Monitoring `serviceruntime.googleapis.com/api/request_count` | 近实时 |
| Vision / Translate 计费量与净费用 | BigQuery 账单导出 | 延迟数小时 |
| Compute Engine 免费/收费流量 | BigQuery 账单导出（按 SKU） | 延迟数小时 |

Google 没有公开 API 能直接读取控制台的「账单报表」，按 SKU 统计用量只能通过 BigQuery 账单导出来查。

面板效果：

```
GCP 用量 · 11月 · 12:51
【主号】
Vision 1,234 次 · 计费 1,530 · $0.75
Translate 56 次 · 计费 123,456
免费流量 29.90 GiB（标准出站 14.59/200）
收费流量 0.01 GiB · $0.0004
  · Carrier Peering 出站 · Americas 0.01 GiB
账单截至 11-10 13:00
```

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

「收费流量」后面的金额是原价减去免费层抵扣（`FREE_TIER`），不扣赠金和促销抵扣，表示这部分流量本身的价格。Vision / Translate 后面的金额是扣掉所有抵扣后的净费用，为 0 时不显示。

## 需要你做的事（每个 GCP 账号各做一遍）

### 1. 在 Cloud Shell 创建服务账号和数据集

登录对应的 Google 账号，打开 [Cloud Shell](https://shell.cloud.google.com)，然后执行：

```bash
PROJECT=你的项目ID          # 用来放账单数据的项目，建议用 VM 所在的项目

gcloud services enable bigquery.googleapis.com monitoring.googleapis.com --project=$PROJECT

# 账单数据集：选 US 多区域，才会回填本月和上月的数据
bq --location=US mk --dataset $PROJECT:billing_export

# 只读服务账号
gcloud iam service-accounts create surge-usage --display-name="Surge usage reader" --project=$PROJECT
SA=surge-usage@$PROJECT.iam.gserviceaccount.com
for ROLE in roles/monitoring.viewer roles/bigquery.jobUser roles/bigquery.dataViewer; do
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=$ROLE --condition=None -q >/dev/null
done

# 生成密钥，复制输出的 JSON 后删除文件
gcloud iam service-accounts keys create key.json --iam-account=$SA
cat key.json && rm key.json
```

如果 Vision / Translate 在其他项目里调用，要给该项目也授予监控只读权限，并把项目 ID 填进配置的 `projects` 里：

```bash
gcloud projects add-iam-policy-binding 其他项目ID --member=serviceAccount:$SA --role=roles/monitoring.viewer --condition=None
```

### 2. 在控制台开启账单导出（只能在网页上操作）

依次进入：结算 → 结算数据导出 → BigQuery Export → **标准使用费用** → 修改设置。项目选 `$PROJECT`，数据集选 `billing_export`，然后保存。

- 开启后要等几个小时才有数据，回填上月的数据最长要 5 天。
- 只需要开「标准使用费用」，「详细使用费用」不用开。
- BigQuery 查询费用可以忽略：每次查询最少按 10 MB 计费，每小时刷新一次一个月约 7 GB，远低于每月 1 TB 的免费额度。

### 3. 填写配置

复制一份 `gcp-usage.js` 到 Surge 配置目录下的 `js/` 子目录（iCloud Drive/Surge/js）。然后编辑 `// <config>` 区块，每个账号写一项：

```js
const ACCOUNTS = [
  {
    name: "主号",
    billingDataset: "my-project.billing_export",
    projects: [],          // 留空表示只统计服务账号所在的项目
    key: { /* 粘贴 key.json 的完整内容 */ },
  },
  { name: "副号", billingDataset: "...", projects: [], key: { ... } },
];
```

**填好密钥的这份文件不要提交到任何仓库**，也不要放到公开的规则仓库里。

### 4. Surge 配置

```ini
[Script]
gcp-usage = type=generic,timeout=60,script-path=js/gcp-usage.js
# 可选：每天 9 点推送一次
gcp-usage-notify = type=cron,cronexp="0 9 * * *",script-path=js/gcp-usage.js,timeout=60,argument=notify=1

[Panel]
GCP = title=GCP 用量,content=加载中,style=info,script-name=gcp-usage,update-interval=86400
```

面板不会在后台刷新，只在两种情况下运行脚本：

- 点面板上的刷新按钮：每次都会重新查询。
- 打开面板所在页面时（iOS 是策略组选择页，Mac 是菜单栏的 Panels 子菜单），如果距上次刷新已超过 `update-interval` 秒，就自动刷新一次。

`86400` 表示自动刷新最多一天一次。

## 注意

- **调用次数和计费量不是一回事**。Monitoring 统计的是请求数，失败的请求也算在内。Vision 按「图片数 × 功能数」计费，每个功能每月前 1000 个单位免费。Translate 按字符计费。
- 账单月按太平洋时间划分，和控制台报表一致。调用次数也从太平洋时间当月 1 日 0 点开始统计。
- access token 缓存在 `$persistentStore` 中，有效期约 1 小时。
- 服务账号只有只读权限（`monitoring.viewer`、`bigquery.dataViewer`、`bigquery.jobUser`）。如果密钥泄露，影响仅限于读取该项目的监控数据和 BigQuery 数据。如果要撤销，在 IAM → 服务账号 → 密钥里删除对应密钥即可。

## 测试

```bash
node test/harness.js
```

测试会在 Node 中模拟 Surge 环境，覆盖以下内容：RS256 签名与 Node crypto 结果一致、两个账号的完整流程、流量分类、部分失败时的显示、太平洋时间账单月计算。
