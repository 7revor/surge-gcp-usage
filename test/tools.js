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
