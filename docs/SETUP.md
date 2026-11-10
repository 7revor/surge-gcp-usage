# 部署手册（供 Agent 引导用户逐步操作）

本手册写给要引导用户完成部署的 Agent。分工如下：

- **用户**：在浏览器里操作，包括 Cloud Shell 命令和 GCP 控制台点击。
- **Agent**：在用户的 Mac 上运行本仓库的本地脚本。

每一步都标了「谁来做」「预期输出」「怎么判断」。一次只给用户一步，等用户贴回输出、对照预期确认无误后再继续。

---

## 0. 引导原则（必须遵守）

1. **密钥不进对话**：
   - 绝不让用户把密钥 JSON 贴到对话里。
   - 不要 `cat`、`Read` 或打印 `keys/` 下的文件。
   - 密钥只能通过 `scripts/import-key.js` 导入，这个脚本只打印 `client_email`。
2. **不在 gcloud 命令上用 `2>/dev/null`**：gcloud 可能弹出「是否启用 API (y/N)」的交互提示。错误输出被吞掉后，这个提示也一起看不见，循环会卡住，看起来就像「没有输出」。需要过滤时加 `--quiet`，或者先判断 API 已启用再查询。
3. **不要凭直觉下结论**：用户说的和输出对不上时，先给诊断命令看清楚，再给方案。
4. **一个账号一个账号来**：多个账号时，每一步都要写明「在哪个账号的 Cloud Shell 里执行」，并把该账号对应的变量值直接填好。
5. **不擅自改用户的安全策略**：涉及组织策略时（步骤 C 的分支），先列出方案让用户选。
6. 命令里的 `<...>` 都是占位符，发给用户前必须替换成实际的值，否则 bash 会报语法错误。
7. 本仓库的约定：
   - 服务账号名统一为 `surge-usage`。
   - 数据集统一为 `<项目ID>.billing_export`，位置为 US 多区域。
   - 密钥文件统一为 `keys/gcp-key-<账号名>.json`。

---

## 1. 收集信息（Agent 问用户）

- 有几个 GCP 账号（Google 登录账号）？每个账号在面板上显示什么名字？名字建议用 ASCII，它同时会成为密钥文件名的一部分。
- Surge 是否使用 iCloud 配置？默认目录是 `~/Library/Mobile Documents/iCloud~com~nssurge~inc/Documents`。Agent 自己检查：

```bash
D=~/Library/Mobile\ Documents/iCloud~com~nssurge~inc/Documents
ls "$D"; grep -nE '^\[(Script|Panel)\]|^#!include' "$D"/*.conf
```

如果 `[Script]` 和 `[Panel]` 段是通过 `#!include` 引入的，比如 `dconf/General.dconf`，步骤 G 的 `--conf` 就填被引入的那个文件。

---

## 步骤 A：摸底（用户，每个账号的 Cloud Shell）

打开 https://shell.cloud.google.com ，**确认登录的是目标账号**，然后执行：

```bash
echo "== 当前账号 =="; gcloud config get-value account
echo "== 项目 =="; gcloud projects list --format="table(projectId,name,parent.type,parent.id)"
echo "== 结算账号 =="; gcloud billing accounts list --format="table(name.basename(),displayName,open)"
echo "== 各项目 API 与 VM =="
for p in $(gcloud projects list --format="value(projectId)"); do
  apis=$(gcloud services list --enabled --project="$p" --format='value(config.name)' --quiet 2>&1 | grep -E '^(compute|vision|translate)\.googleapis\.com$' | tr '\n' ' ')
  echo "[$p] API: $apis"
  case "$apis" in *compute*)
    gcloud compute instances list --project="$p" --quiet --format="table[no-heading](name,zone.basename(),status,networkInterfaces[0].accessConfigs[0].networkTier)";;
  esac
done
```

根据输出判断：

| 看什么 | 结论 |
|---|---|
| 哪个项目有 VM | 这个项目作为**账单数据项目**（`PROJECT`）。没有 VM 时，选启用了 vision/translate 的项目 |
| vision/translate 在哪些项目里启用 | 如果不在 `PROJECT` 里，这些项目 ID 要填进 `accounts.local.json` 的 `projects`，并在步骤 B 补授监控权限 |
| 项目的 `parent.type` 是 `organization` | 这个账号大概率启用了「默认安全」组织策略，步骤 C 很可能需要走分支 C-2 |
| 结算账号 ID | 记下来，步骤 E 要用 |
| AI Studio 自动创建的 `gen-lang-client-*` 项目 | 通常没有关联结算，忽略即可 |

---

## 步骤 B：建数据集和只读服务账号（用户，每个账号的 Cloud Shell）

Agent 把 `PROJECT` 换成步骤 A 确定的项目再发给用户：

```bash
PROJECT=<账单数据项目ID>

echo "== 结算是否已关联（应为 True） =="
gcloud billing projects describe $PROJECT --format="value(billingEnabled)"

echo "== 启用 API / 建数据集 =="
gcloud services enable bigquery.googleapis.com monitoring.googleapis.com --project=$PROJECT
bq ls --project_id=$PROJECT | grep -qw billing_export || bq --project_id=$PROJECT --location=US mk --dataset $PROJECT:billing_export

echo "== 服务账号与授权 =="
gcloud iam service-accounts describe surge-usage@$PROJECT.iam.gserviceaccount.com --project=$PROJECT >/dev/null 2>&1 \
  || { gcloud iam service-accounts create surge-usage --display-name="Surge usage reader" --project=$PROJECT && sleep 15; }
SA=surge-usage@$PROJECT.iam.gserviceaccount.com
for ROLE in roles/monitoring.viewer roles/bigquery.jobUser roles/bigquery.dataViewer; do
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=$ROLE --condition=None -q >/dev/null && echo "已授权 $ROLE"
done
```

预期输出：`True`、`Dataset ... successfully created`（已存在时不输出）、3 行「已授权」。

- 结算显示 `False`：先在控制台把这个项目关联到结算账号。否则 BigQuery 处于沙盒模式，表 60 天后会自动删除。
- 如果 vision/translate 还在其他项目里调用，给每个这样的项目补授监控权限：
  ```bash
  gcloud projects add-iam-policy-binding <其他项目ID> --member=serviceAccount:$SA --role=roles/monitoring.viewer --condition=None -q >/dev/null && echo 已授权
  ```

---

## 步骤 C：生成密钥（用户，每个账号的 Cloud Shell）

```bash
PROJECT=<账单数据项目ID>; NAME=<账号名>
SA=surge-usage@$PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts keys create ~/gcp-key-$NAME.json --iam-account=$SA && cloudshell download ~/gcp-key-$NAME.json
```

正常情况下浏览器会弹出下载，让用户保存到「下载」文件夹，然后进入步骤 D。

### 分支 C-1：`Unable to create private file ... Permission denied`

这是 Cloud Shell 主目录不可写。gcloud 是先在服务端创建密钥、再写本地文件，所以服务端可能已经生成了一把没保存下来的密钥，要先删掉：

```bash
for k in $(gcloud iam service-accounts keys list --iam-account=$SA --managed-by=user --format="value(name.basename())"); do
  gcloud iam service-accounts keys delete $k --iam-account=$SA -q && echo "已删除 $k"
done
gcloud iam service-accounts keys create /tmp/gcp-key-$NAME.json --iam-account=$SA && cat /tmp/gcp-key-$NAME.json
```

注意：上面的循环会删除这个服务账号的**全部**用户管理密钥，只能在服务账号刚建好、还没有正在使用的密钥时执行。

`cloudshell download` 只能下载主目录里的文件，所以改走剪贴板：

1. 让用户选中 `cat` 输出的内容，从第一个 `{` 选到最后一个 `}`，按 ⌘C。
2. 用户回复「已复制」，**不要贴内容**。
3. Agent 执行步骤 D 的 `--clipboard` 方式。终端复制时长行被软换行打断造成的断行，导入脚本会自动修复。
4. 导入成功后，让用户执行 `rm /tmp/gcp-key-*.json`。

### 分支 C-2：`Key creation is not allowed on this service account`（`constraints/iam.disableServiceAccountKeyCreation`）

2024-05-03 之后新建的组织默认启用「默认安全」组织策略，禁止创建服务账号密钥。新建结算账号时如果没有关联组织，Google 也可能自动建一个组织。把下面两个方案列给用户，让用户选：

| 方案 | 做法 | 取舍 |
|---|---|---|
| 共用服务账号 | 在这个项目里，给**另一个账号**的 `surge-usage` 服务账号授予步骤 B 的 3 个角色；`accounts.local.json` 里这个账号的 `keyFile` 指向那个账号的密钥 | 不改安全策略；但这个账号会依赖另一个账号 |
| 只放开这个项目 | 用户给自己授予组织政策管理员角色，只在这个项目上关闭策略，再生成独立密钥 | 账号之间互相独立；但这个项目失去该项防护 |

共用方案要求组织策略允许外部成员。先确认 `constraints/iam.allowedPolicyMemberDomains` 是 `allValues: ALLOW`：

```bash
gcloud resource-manager org-policies describe constraints/iam.allowedPolicyMemberDomains --project=$PROJECT --effective --quiet
```

只放开项目的方案：

```bash
ORG=$(gcloud projects describe $PROJECT --format="value(parent.id)")
ME=$(gcloud config get-value account)
echo "== 自己在组织中的角色（需要有 roles/resourcemanager.organizationAdmin） =="
gcloud organizations get-iam-policy $ORG --flatten=bindings --filter="bindings.members:user:$ME" --format="value(bindings.role)"

gcloud organizations add-iam-policy-binding $ORG --member=user:$ME --role=roles/orgpolicy.policyAdmin --condition=None -q >/dev/null && echo "已授予 policyAdmin"
sleep 60
gcloud resource-manager org-policies disable-enforce iam.disableServiceAccountKeyCreation --project=$PROJECT
gcloud resource-manager org-policies describe constraints/iam.disableServiceAccountKeyCreation --project=$PROJECT --effective
```

最后一条输出 `booleanPolicy: {}` 就表示已不再强制。**组织策略最长要 15 分钟才生效**，所以用下面的循环自动重试生成密钥：

```bash
for i in $(seq 1 15); do
  if gcloud iam service-accounts keys create ~/gcp-key-$NAME.json --iam-account=$SA 2>/tmp/keyerr; then
    echo "✓ 第 $i 次成功"; cloudshell download ~/gcp-key-$NAME.json; break
  fi
  echo "第 $i 次失败：$(grep -o 'type: .*' /tmp/keyerr | head -1)，60 秒后重试"; sleep 60
done
```

- 报错类型变成 `iam.managed.disableServiceAccountKeyCreation`：组织还启用了托管版策略。在控制台「IAM 和管理 → 组织政策」里切到**项目**层级，搜索「停用服务账号密钥创建」，把列出的条目都设为「不强制执行」。（这条路径未实测。）
- 拿到密钥后，可以撤销刚授予的管理员角色，项目上的策略例外不受影响：
  ```bash
  gcloud organizations remove-iam-policy-binding $ORG --member=user:$ME --role=roles/orgpolicy.policyAdmin --condition=None -q >/dev/null && echo 已撤销
  ```

---

## 步骤 D：导入密钥（Agent，在 Mac 上）

在仓库根目录执行（主检出目录，不是 worktree，因为 `keys/` 只放在主目录）：

```bash
# 用户下载到了「下载」文件夹：
node scripts/import-key.js <账号名> --file ~/Downloads/gcp-key-<账号名>.json --move --billing-account <结算账号ID>
# 用户复制到了剪贴板：
node scripts/import-key.js <账号名> --clipboard --billing-account <结算账号ID>
```

预期输出：`✓ keys/gcp-key-<账号名>.json`、`client_email`、「与 Google 登记的公钥匹配」，以及 `accounts.local.json` 已新增该账号。

导入脚本会做这些事：
- 修复终端断行。
- 用 Google 的 x509 证书接口校验私钥。
- 写入 `keys/` 目录，文件权限 600。
- 把账号登记到 `accounts.local.json`，数据集默认为 `<project_id>.billing_export`。
- `--clipboard` 方式会在完成后清空剪贴板；`--move` 方式会删除源文件。

如果这个账号用的是共用服务账号（分支 C-2 的共用方案），就不用导入，直接手动在 `accounts.local.json` 里加一项：`keyFile` 指向被共用的密钥，`billingDataset` 填这个账号自己的数据集。

---

## 步骤 E：开启账单导出（用户，每个账号的控制台）

Agent 把结算账号 ID 填进链接里发给用户：`https://console.cloud.google.com/billing/<结算账号ID>/export`

页面操作：
1. 在「BigQuery Export」标签页找到**「标准使用费用」**（Standard usage cost），点「修改设置」。
2. 项目选 `PROJECT`，数据集选 `billing_export`，保存。
3. 如果提示启用 BigQuery Data Transfer API，点启用。

「详细使用费用」和「价格」不用开。开启后**要等几个小时**才会出现 `gcp_billing_export_v1_*` 表；回填本月和上月的数据最长要 5 天。

---

## 步骤 F：本地校验（Agent）

```bash
node scripts/verify-keys.js      # 每个账号都应显示 ✓
node test/live.js                # 用真实接口跑一次面板
```

`live.js` 的预期输出：

- 每个账号都有 `Vision N 次 · 已用/1,000` 和 `Translate N 次 · 已用/50万字符` 两行。这两行的数据来自 Monitoring，开启账单导出前就能看到。
- 导出表还没生成时，底部会显示「⚠ 账单：数据未就绪」，这是正常的。
- 表生成之后，会出现「免费流量」「收费流量」「账单截至」几行。

---

## 步骤 G：安装到 Surge（Agent）

```bash
node scripts/install-surge.js --conf dconf/General.dconf --dry-run   # 先预览
node scripts/install-surge.js --conf dconf/General.dconf             # 正式安装
```

- `--conf` 填步骤 1 里查到的、包含 `[Script]` 和 `[Panel]` 段的文件。
- 修改前会把原配置文件备份到系统临时目录。
- 已经登记过的话不会重复添加；被注释掉的行不算已登记。
- 面板自动刷新间隔默认 86400 秒，可以用 `--interval` 修改。面板行已经登记过时，带上 `--interval` 会把它的 `update-interval` 改成新值。
- 安装后会用装好的脚本做一次真实查询，并打印面板内容。

告诉用户：
- 在 Surge 里打开面板，iOS 在策略组选择页，Mac 在菜单栏的 Panels 子菜单。
- 面板不会在后台刷新。只有手动点刷新，或者打开面板页时距上次刷新已超过刷新间隔，才会重新查询。

---

## 步骤 H：账单数据到位后复核（Agent，几小时后）

运行 `node test/live.js`，然后对照控制台「结算 → 报表」，按 SKU 分组、只看本月，逐项核对：

- **免费流量**：等于所有入站 SKU、标准层互联网出站（200 GiB 以内）、发往 Google 服务等零费用出站 SKU 的总和。
- **收费流量**：等于 Carrier Peering 出站 SKU，加上其他扣除免费层抵扣后仍有费用的流量 SKU。
- 刚开启导出的头几天还在回填，数字可能偏低。

---

## 故障排查（都是实际遇到过的情况）

| 现象 | 原因 | 处理 |
|---|---|---|
| for 循环查询 VM 没有任何输出 | `2>/dev/null` 吞掉了「启用 API？(y/N)」提示，循环卡在第一个项目 | 用步骤 A 的写法：加 `--quiet`，并且先判断 compute API 已启用再查 VM |
| `Unable to create private file ... Permission denied` | Cloud Shell 主目录不可写 | 分支 C-1 |
| `File /tmp/... is not in user's home directory` | `cloudshell download` 只能下载主目录里的文件 | 改用剪贴板方式，步骤 D 的 `--clipboard` |
| `JSONDecodeError: Invalid control character` | 从终端复制时，长行被软换行打断 | `import-key.js` 会自动修复 |
| `Key creation is not allowed ... iam.disableServiceAccountKeyCreation` | 组织的「默认安全」策略 | 分支 C-2 |
| 关闭策略后仍然报同样的错 | 组织策略还在传播，最长 15 分钟 | 用分支 C-2 的重试循环 |
| `Billing account for project ... is not found` | 对没有关联结算的项目启用了 API | 和本方案无关，忽略 |
| `⚠ 账单：数据未就绪` | 还没开启账单导出，或开启不到几小时 | 确认步骤 E 已完成，等待 |
| 面板上的错误被截短，看不出原因 | 面板一行放不下 | 完整错误在 Surge 的脚本日志里，以 `[gcp-usage]` 开头；`live.js` 也会打印 |
| `⚠ 调用量：无权限`（`live.js` 显示 HTTP 403） | `projects` 里的某个项目没有给服务账号授予 `roles/monitoring.viewer` | 按步骤 B 补授权限 |
| `⚠ 账单：无权限`（`bigquery.jobs.create` 被拒绝） | 账单数据项目缺少 `roles/bigquery.jobUser` | 按步骤 B 补授权限 |
| `✗ 校验失败：Google 上找不到该 private_key_id` | 密钥已在控制台被删除 | 重新执行步骤 C 和 D（导入时加 `--force`） |
| 几个账号的 Vision/Translate 次数相同 | 多半是同一个客户端在轮流使用这几个账号，不是 bug | 用每天的原始数据核对：`timeSeries.list` 设置 `alignmentPeriod=86400s` |

---

## 日常维护

- **修改了 `gcp-usage.js`**：先跑 `node test/harness.js && node test/tools.js && node test/live.js`，再重新执行步骤 G。Surge 里的脚本是生成出来的副本，不会自动同步。
- **新增账号**：对新账号走一遍步骤 A–G。导入后 `accounts.local.json` 会自动追加，然后重新执行 `install-surge.js`。
- **轮换密钥**：
  1. 用户在 Cloud Shell 生成新密钥（步骤 C）。
  2. Agent 执行 `import-key.js <账号名> ... --force`，然后重新执行 `install-surge.js`。
  3. 让用户删除旧密钥：`gcloud iam service-accounts keys list --iam-account=$SA --managed-by=user`，再 `gcloud iam service-accounts keys delete <旧ID> --iam-account=$SA`。
- **撤销某个账号的访问权限**：在该账号的 IAM → 服务账号 → `surge-usage` → 密钥里删除密钥，再从 `accounts.local.json` 里删掉这一项，然后重新安装。
