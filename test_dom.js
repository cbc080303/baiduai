// 页面端到端断言：在最小 DOM stub 里执行 index.html 的内联脚本，
// 再用示例转录与第 2 组实录各跑一次 runA()，确认渲染不报错、机构清单段出现。
// 跑法：node test_dom.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HERE = __dirname;
const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

function makeEl(id){
  return {
    id, innerHTML: "", textContent: "", value: "", className: "", checked: true,
    style: {}, childNodes: [],
    addEventListener(){}, removeEventListener(){}, appendChild(c){ this.childNodes.push(c); return c; },
    setAttribute(){}, getAttribute(){ return null; }, removeAttribute(){},
    classList: {add(){}, remove(){}, toggle(){}, contains(){ return false; }},
    querySelector(){ return makeEl("child"); }, querySelectorAll(){ return []; },
    focus(){}, scrollIntoView(){},
  };
}

const store = {};
const document = {
  getElementById: id => store[id] || (store[id] = makeEl(id)),
  querySelector: sel => store[sel] || (store[sel] = makeEl(sel)),
  querySelectorAll: () => [],
  createElement: tag => makeEl(tag),
  addEventListener(){},
  body: makeEl("body"),
};

const ctx = {document, window: {document, addEventListener(){}}, console, setTimeout, clearTimeout};
vm.createContext(ctx);
vm.runInContext(code, ctx, {filename: "index.inline.js"});
console.log("PASS  内联脚本在 DOM stub 中完整执行（renderGen / renderRev / renderIssues / renderOrg 已跑）");

function runAWith(text, label){
  store["tr-input"].value = text;
  store["a-out"].innerHTML = "";
  store["a-out"].textContent = "";
  ctx.runA();
  // stub 里两个属性互不影响；真实 DOM 中 innerHTML 赋值会清掉 textContent，这里合并取
  return store["a-out"].innerHTML + store["a-out"].textContent;
}

// 1) 示例转录：应出 4 条候选，无不成立的误报
const sample = fs.readFileSync(path.join(HERE, "会议转录_产品运营周会_示例.txt"), "utf8");
const a1 = runAWith(sample, "示例");
const cands1 = (a1.match(/class="num"/g) || []).length;
if (a1.indexOf("候选 <b>4</b>") < 0) throw new Error("示例转录候选数不是 4：" + a1.slice(0, 160));
console.log("PASS  示例转录渲染：候选 4 条，表格行 " + cands1);

// 2) 第 2 组实录：候选应被规则排到 0，机构主体清单出现
const mof = fs.readFileSync(path.join(HERE, "会议转录_公开实录_第2组.txt"), "utf8");
const a2 = runAWith(mof, "第2组");
if (a2.indexOf("候选 <b>0</b>") < 0) throw new Error("第 2 组候选数不是 0：" + a2.slice(0, 160));
if (a2.indexOf("机构主体清单") < 0) throw new Error("第 2 组未渲染机构主体清单");
if (a2.indexOf("机构主体只作提醒") < 0) throw new Error("机构清单缺边界说明");
const orgRows = (a2.match(/class="num"/g) || []).length;
console.log("PASS  第 2 组渲染：候选 0 条、机构清单已渲染，表格行 " + orgRows);

// 3) 无「参会人：」行时给出明确提示而不是空白
const a3 = runAWith("张岚：随便说两句，没有名单行。\n", "无名单");
if (a3.indexOf("没读到「参会人：」行") < 0) throw new Error("缺名单行时未提示");
console.log("PASS  缺「参会人：」行时给出降级提示");

console.log("\nALL DOM ASSERT PASS");