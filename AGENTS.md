# AGENTS.md

这是一个 Surge 面板脚本，用来分账号查询多个 GCP 账号本月的 Vision / Translate 调用次数和计费量，以及 Compute Engine 的免费/收费流量。原理和规则见 `README.md`。

## 要引导用户部署或新增账号

按 `docs/SETUP.md` 一步一步来。不要跳步，不要凭直觉下结论，每一步都要等用户贴回输出。

## 硬性规则

1. **密钥绝不外泄**：
   - `keys/`、`accounts.local.json`、Surge 目录下的 `js/gcp-usage.js` 都含有私钥或账号信息。
   - 不要 `cat`、`Read`、`grep` 或打印它们的内容，也不要让用户把密钥贴进对话。
   - 需要读取字段时，用脚本只输出 `client_email` 这类非敏感字段。
   - 导入密钥只能用 `scripts/import-key.js`。
2. **不提交密钥**：`.gitignore` 已经忽略 `keys/`、`*.local.json` 和 `gcp-key-*.json`。提交前要用 `git status --short` 确认。
3. **`keys/` 和 `accounts.local.json` 只放在主检出目录**：在 worktree 里运行本地脚本时，要用 `--accounts <主目录>/accounts.local.json` 指过去，`keyFile` 会按这个文件所在的目录解析。
4. **修改 `gcp-usage.js` 时要保持与 JavaScriptCore（Surge 运行时）兼容**：
   - 不能用 Node API、`require`、顶层 `await`、`fetch`、`atob` 或 `TextEncoder`。
   - 只能用 Surge 提供的 `$httpClient`、`$persistentStore`、`$notification`、`$done`、`$argument`、`$trigger`。
   - 入口调用必须放在文件末尾。`main()` 会同步执行到第一个 `await`，如果入口放在前面，后面的 `const` 还处在暂时性死区（TDZ），会报错。
   - 可以用 BigInt，RS256 签名依赖它。
   - 可以用 macOS 的 JXA 验证：`osascript -l JavaScript`，它同样运行在 JSC 上。
5. **Surge 里的脚本是生成出来的副本**：修改源码后，必须重新运行 `scripts/install-surge.js`，Surge 里的脚本才会更新。
6. **不要直接修改用户的 GCP 安全策略**：涉及组织策略或权限放宽时，先说明利弊，让用户自己选。

## 文件

| 路径 | 说明 |
|---|---|
| `gcp-usage.js` | Surge 脚本源码。`// <config>` 区块是占位符，由安装脚本填入真实配置 |
| `scripts/import-key.js` | 从下载的文件或剪贴板导入密钥，修复断行，校验后登记账号 |
| `scripts/verify-keys.js` | 校验所有密钥是否仍然有效 |
| `scripts/install-surge.js` | 生成配置好的脚本，安装到 Surge 并登记 `[Script]` 和 `[Panel]` |
| `scripts/lib.js` | 上面几个脚本共用的函数，包括在 Node 中模拟 Surge 运行时 |
| `test/harness.js` | 离线测试：签名、分类、多账号、时区 |
| `test/tools.js` | 离线测试：断行修复 |
| `test/live.js` | 用真实接口跑一次面板，不修改任何文件 |
| `accounts.example.json` | `accounts.local.json` 的格式示例 |
| `keys/`、`accounts.local.json` | 本地密钥和账号配置（已被 git 忽略） |

## 常用命令

```bash
node test/harness.js && node test/tools.js   # 离线测试
node scripts/verify-keys.js                  # 校验密钥
node test/live.js                            # 用真实接口跑一次
node scripts/install-surge.js --conf dconf/General.dconf   # 安装或更新 Surge 脚本
```
