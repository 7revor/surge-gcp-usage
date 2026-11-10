// 本地工具脚本的离线测试：node test/tools.js
"use strict";
const assert = require("assert");
const { repairJson } = require("../scripts/lib");

const obj = { a: "line1\nline2", b: 'x\\y"z', private_key: "-----BEGIN-----\nABCDEF\n-----END-----\n" };
const s = JSON.stringify(obj, null, 2);
for (let i = 1; i < s.length; i++) {
  assert.deepStrictEqual(repairJson(s.slice(0, i) + "\n" + s.slice(i)).json, obj, "断行位置 " + i);
}
assert.deepStrictEqual(repairJson("user@cloudshell:~$ cat k\n" + s + "\nuser@cloudshell:~$ ").json, obj);
console.log(`✓ repairJson：任意位置断行都能还原（${s.length - 1} 处）`);

// parseFlags：开关不吞后面的位置参数；值里可以带 =
const { parseFlags, ensureLine, setPanelInterval } = require("../scripts/lib");
assert.deepStrictEqual(parseFlags(["--clipboard", "main"]), { _: ["main"], clipboard: true });
assert.deepStrictEqual(parseFlags(["main", "--file", "a.json", "--move", "--force"]), { _: ["main"], file: "a.json", move: true, force: true });
assert.deepStrictEqual(parseFlags(["--dataset=a.b=c", "--interval", "3600", "--dry-run", "x"]), { _: ["x"], dataset: "a.b=c", interval: "3600", "dry-run": true });
console.log("✓ parseFlags");

// Surge 配置：登记脚本行和面板行
const SCRIPT_RE = /^\s*gcp-usage\s*=/;
const PANEL_RE = /script-name\s*=\s*gcp-usage\s*(,|$)/;
const S = "gcp-usage = type=generic,timeout=60,script-path=js/gcp-usage.js";
const P = "GCP = title=GCP 用量,script-name=gcp-usage,update-interval=86400";
const reg = (t) => ensureLine(ensureLine(t, "Script", S, SCRIPT_RE), "Panel", P, PANEL_RE);

let conf = reg("[General]\nloglevel = notify\n\n[Script]\nother = type=cron\n\n[Panel]\n");
assert.strictEqual(conf, `[General]\nloglevel = notify\n\n[Script]\nother = type=cron\n${S}\n\n[Panel]\n${P}\n`);
assert.strictEqual(reg(conf), conf, "已登记时不重复添加");
assert.strictEqual(reg("[General]\n"), `[General]\n\n[Script]\n${S}\n\n[Panel]\n${P}\n`, "段不存在时新建");
// 被注释掉的行、gcp-usage-notify 都不算已登记
conf = reg(`[Script]\n# ${S}\ngcp-usage-notify = type=cron,script-path=js/gcp-usage.js\n[Panel]\n# ${P}\nX = script-name=gcp-usage-notify\n`);
assert.ok(conf.includes(`\n${S}\n[Panel]`) && conf.endsWith(`X = script-name=gcp-usage-notify\n${P}\n`));
// --interval 更新已登记的面板行，不动别的行
conf = `[Panel]\n# ${P}\n${P}\nOther = script-name=x,update-interval=5\n`;
assert.strictEqual(setPanelInterval(conf, PANEL_RE, 3600), `[Panel]\n# ${P}\n${P.replace("86400", "3600")}\nOther = script-name=x,update-interval=5\n`);
assert.strictEqual(setPanelInterval("[Panel]\nGCP = script-name=gcp-usage\r\n", PANEL_RE, 60), "[Panel]\nGCP = script-name=gcp-usage,update-interval=60\r\n");
console.log("✓ Surge 配置行登记与刷新间隔更新");
