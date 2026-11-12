// 下載證交所（上市）與櫃買中心（上櫃）每日收盤資料，整理成 App 用的小檔案 data/tw-stocks.json
// 用法：node scripts/update-tw-stocks.mjs   （GitHub Actions 每個交易日收盤後自動執行）
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'data', 'tw-stocks.json');

async function getJson(url, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(240000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  throw new Error(`${url} 失敗：${lastError?.message}`);
}

const isStockOrEtf = (code) => /^\d{4}$/.test(code) || /^00\d{3,4}[A-Z]?$/.test(code);
const price = (value) => { const n = Number(String(value ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) && n > 0 ? n : null; };

const rows = new Map();
const twse = await getJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
for (const row of twse) {
  const code = String(row.Code || '').trim();
  if (isStockOrEtf(code)) rows.set(code, [code, String(row.Name || '').trim(), price(row.ClosingPrice), '市']);
}
let date = String(twse[0]?.Date || '');
try {
  const tpex = await getJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes');
  for (const row of tpex) {
    const code = String(row.SecuritiesCompanyCode || '').trim();
    if (isStockOrEtf(code) && !rows.has(code)) rows.set(code, [code, String(row.CompanyName || '').trim(), price(row.Close), '櫃']);
  }
  date = date || String(tpex[0]?.Date || '');
} catch (error) { console.warn('櫃買資料取得失敗，只輸出上市：', error.message); }

if (rows.size < 500) throw new Error(`資料筆數異常（${rows.size}），不覆蓋舊檔`);
const list = [...rows.values()].sort((a, b) => a[0].localeCompare(b[0]));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ updated: new Date().toISOString(), tradeDate: date, count: list.length, rows: list }) + '\n', 'utf8');
console.log(`已寫入 ${list.length} 檔（資料日 ${date}）`);
