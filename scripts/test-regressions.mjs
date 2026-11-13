import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`); assert.notEqual(start, -1, `找不到 ${name}`);
  const brace = source.indexOf("{", start); let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} 大括號不完整`);
}
const names = ["asArray", "number", "hasRelation", "rate", "toTWD", "fromTWD", "sourceAmount", "feeInAccount", "transactionTWD", "accountBalance", "calendarDate", "latestMonthlyDate", "nextMonthlyDateAfter", "daysBetween"];
const sandbox = { state: { settings: { rateTWD: 1, rateTHB: 0.9753797468 }, transactions: [] } };
vm.createContext(sandbox);
vm.runInContext(`${names.map(functionSource).join("\n")}\nthis.api={${names.join(",")}};`, sandbox);
const f = sandbox.api;

const thbAccount = { id: "kbank", p: { 幣別: "THB", 期初餘額: 267403.5, 開帳日: "2026-11-12" } };
const thbExpense = { id: "tx", p: { 收支: "支出", 日期: "2026-11-13", 原幣金額: 158, 台幣金額: 154.11, 幣別: "THB", 帳戶: ["kbank"] } };
sandbox.state.transactions = [thbExpense];
assert.equal(f.sourceAmount(thbExpense, "THB"), 158, "泰銖帳戶必須扣原幣 158 THB");
assert.equal(f.accountBalance(thbAccount), 267245.5, "先以 THB 扣款，不能拿 154.11 扣 THB");
assert.equal(f.transactionTWD(thbExpense), 154.11, "台幣金額只供統計");
assert.equal(Number((f.accountBalance(thbAccount) * f.rate("THB")).toFixed(6)), Number((267245.5 * 0.9753797468).toFixed(6)), "扣款後餘額才換算台幣");

const twdAccount = { id: "cash", p: { 幣別: "TWD", 期初餘額: 1000, 開帳日: "2026-01-01" } };
const twdExpense = { p: { 收支: "支出", 日期: "2026-11-13", 原幣金額: 158, 台幣金額: 158, 幣別: "TWD", 帳戶: ["cash"] } };
sandbox.state.transactions = [twdExpense];
assert.equal(f.accountBalance(twdAccount), 842, "同幣別支出 158 必須精確扣 158");
assert.equal(f.transactionTWD(twdExpense), 158, "同幣別統計必須精確為 158");

assert.equal(f.latestMonthlyDate(31, "2026-02-28"), "2026-02-28", "2 月結帳日 31 應落在月底");
assert.equal(f.nextMonthlyDateAfter(2, "2026-02-28"), "2026-03-02", "跨月繳款日應正確");
assert.match(source, /約 \$\{convertedMoney\(transactionTWD\(row\)\)\}/, "跨幣別交易需標示精確換算金額");
assert.match(source, /nativeCodeMoney\(nativeAmount\(row\), currency\)/, "交易主金額需顯示原幣代號");

console.log("OK: 原幣扣款、台幣統計、同幣別 158、月底信用卡日期與顯示規則");
