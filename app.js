"use strict";

const APP_VERSION = "2.6.1-p3";
const DB_NAME = "pocket-piggy";
const DB_VERSION = 1;
const TABLES = ["accounts", "holdings", "recurring", "snapshots", "transactions"];
const STORES = [...TABLES, "meta", "outbox", "failed"];
const RELATION_FIELDS = new Set(["帳戶", "轉入帳戶", "固定支出", "持倉", "扣款帳戶", "對應資產帳戶", "對應持倉"]);
const COLORS = ["#f38ba0", "#9ed9c5", "#b9a6e8", "#f6d77a", "#8ec7e8", "#ffc6a8"];
const DEFAULT_SETTINGS = {
  id: "settings",
  baseUrl: "https://jerry-hsieh.app.n8n.cloud/webhook",
  token: "",
  displayCurrency: "TWD",
  rateTWD: 1,
  rateTHB: 0.93,
  rateUSD: 32.5,
  rateJPY: 0.215,
  currencies: [],
  cgIds: {},
};
const FIAT_CURRENCIES = ["TWD", "THB", "USD", "JPY"];
const CRYPTO_CURRENCIES = ["BTC", "ETH", "USDT", "USDC"];
const COUNTRIES = ["台灣", "泰國", "美國", "日本", "中國", "香港", "新加坡", "馬來西亞", "越南", "韓國", "英國", "歐盟", "澳洲", "加拿大", "全球／無國界", "其他"];
const INVESTMENT_ACCOUNT_TYPES = ["投資", "加密貨幣", "台股", "美股", "泰國基金"];
// 下拉選單：內建選項 ∪ 資料裡已出現的值 ∪ 自己新增的 − 自己刪除的（使用中的值不能刪）。值對齊 Notion 欄位選項。
const OPTION_BASE = {
  country: COUNTRIES,
  type: ["銀行", "現金", "電子支付", "信用卡", "保險", "投資", "加密貨幣"],
  insurance: ["儲蓄險", "終身壽險", "投資型保單", "定期壽險", "醫療險", "意外險", "產險車險"],
};
const OPTION_FIELD = { country: "國家", type: "類型", insurance: "保險種類" };
const OPTION_LABEL = { country: "國家", type: "帳戶類型", insurance: "保險種類", currency: "幣別" };
const INCLUDE_YES = ["計入資產", "是"];
// 加密貨幣代號 → CoinGecko id；不在表內的代號會在更新報價時用 CoinGecko 搜尋自動對照
const COINGECKO_IDS = { BTC: "bitcoin", XBT: "bitcoin", WBTC: "wrapped-bitcoin", ETH: "ethereum", SOL: "solana", USDT: "tether", USDC: "usd-coin", USDD: "usdd", DAI: "dai", BNB: "binancecoin", XRP: "ripple", DOGE: "dogecoin", ADA: "cardano", TRX: "tron", TON: "the-open-network", AVAX: "avalanche-2", DOT: "polkadot", LINK: "chainlink", LTC: "litecoin", BCH: "bitcoin-cash", SHIB: "shiba-inu", MATIC: "matic-network", POL: "polygon-ecosystem-token", UNI: "uniswap", ATOM: "cosmos", XLM: "stellar", NEAR: "near", APT: "aptos", ARB: "arbitrum", OP: "optimism", SUI: "sui", PEPE: "pepe", ETC: "ethereum-classic", FIL: "filecoin", HYPE: "hyperliquid" };

const state = {
  db: null,
  settings: { ...DEFAULT_SETTINGS },
  accounts: [], holdings: [], recurring: [], snapshots: [], transactions: [],
  outbox: [], failed: [], lastSync: null, receiptIds: new Set(),
  view: "overview", editor: null, wizardStep: 0, wizardDate: todayISO(), syncing: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
function todayISO() { return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }); }
function nowISO() { return new Date().toISOString(); }
function asArray(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function number(value) { const n = Number(typeof value === "string" ? value.replace(/[,，\s]/g, "") : value); return Number.isFinite(n) ? n : 0; }
function roundedNumber(value, digits = 8) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : 0;
}
function hasRelation(value, id) { return asArray(value).includes(id); }
function iconFor(type = "") { return ({ 銀行: "🏦", 現金: "💵", 信用卡: "💳", 保險: "🛡️", 加密貨幣: "₿", 台股: "📊", 美股: "🗽", 泰國基金: "🌴" })[type] || "🐷"; }

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function tx(store, mode = "readonly") { return state.db.transaction(store, mode).objectStore(store); }
function requestResult(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function getAll(store) { return requestResult(tx(store).getAll()); }
async function getOne(store, id) { return requestResult(tx(store).get(id)); }
async function putOne(store, value) { return requestResult(tx(store, "readwrite").put(value)); }
async function deleteOne(store, id) { return requestResult(tx(store, "readwrite").delete(id)); }
async function clearStore(store) { return requestResult(tx(store, "readwrite").clear()); }
async function putMany(store, values) {
  if (!values.length) return;
  await new Promise((resolve, reject) => {
    const transaction = state.db.transaction(store, "readwrite");
    const objectStore = transaction.objectStore(store);
    values.forEach((value) => objectStore.put(value));
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
  });
}

async function loadState() {
  const [settings, lastSync, metaKeys, ...collections] = await Promise.all([
    getOne("meta", "settings"), getOne("meta", "lastSync"), requestResult(tx("meta").getAllKeys()),
    ...TABLES.map(getAll), getAll("outbox"), getAll("failed"),
  ]);
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  state.lastSync = lastSync?.value || null;
  state.receiptIds = new Set(metaKeys.filter((key) => String(key).startsWith("receipt-")));
  TABLES.forEach((table, index) => { state[table] = collections[index] || []; });
  state.outbox = collections[TABLES.length] || [];
  state.failed = collections[TABLES.length + 1] || [];
}

function customCurrencies() { return Array.isArray(state.settings.currencies) ? state.settings.currencies : []; }
function currencyList() {
  const seen = new Set(); const list = [];
  const hidden = Array.isArray(state.settings.hiddenCurrencies) ? state.settings.hiddenCurrencies : [];
  for (const item of [...FIAT_CURRENCIES.map((code) => ({ code, kind: "fiat", builtin: true })), ...CRYPTO_CURRENCIES.map((code) => ({ code, kind: "crypto", builtin: true })), ...customCurrencies()]) {
    if (item?.code && !seen.has(item.code) && (item.code === "TWD" || !item.builtin || !hidden.includes(item.code))) { seen.add(item.code); list.push(item); }
  }
  return list;
}
function optionState(key) { const o = state.settings.options?.[key] || {}; return { add: asArray(o.add), remove: asArray(o.remove) }; }
function optionUsedCount(key, value) {
  if (key === "currency") return state.accounts.filter((r) => r.p?.幣別 === value).length + state.holdings.filter((r) => r.p?.計價幣別 === value).length + state.recurring.filter((r) => r.p?.幣別 === value).length + state.transactions.filter((r) => r.p?.幣別 === value).length;
  return state.accounts.filter((r) => r.p?.[OPTION_FIELD[key]] === value).length;
}
function optionList(key) {
  if (key === "currency") return currencyCodes();
  const { add, remove } = optionState(key); const used = state.accounts.map((r) => r.p?.[OPTION_FIELD[key]]).filter(Boolean);
  const out = [];
  for (const value of [...OPTION_BASE[key], ...add, ...used]) if (value && !out.includes(value) && (!remove.includes(value) || used.includes(value))) out.push(value);
  return out;
}
function currencyCodes() { return currencyList().map((item) => item.code); }
function isCrypto(currency) { return currencyList().some((item) => item.code === currency && item.kind === "crypto"); }
// 1 單位該幣別等於多少台幣；還沒取得匯率的幣別回傳 0（不計入總額，避免亂算）
function rate(currency = "TWD") {
  if (!currency || currency === "TWD") return 1;
  const value = number(state.settings[`rate${currency}`]);
  return value > 0 ? value : 0;
}
function toTWD(amount, currency = "TWD") { return number(amount) * rate(currency); }
function fromTWD(amount, currency = state.settings.displayCurrency) { const r = rate(currency); return r ? number(amount) / r : 0; }
function currencySymbol(currency) { return ({ TWD: "NT$", THB: "฿", USD: "US$", JPY: "¥" })[currency] || `${currency} `; }
function formatNumber(value, maxDigits = 2) { return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: maxDigits }).format(number(value)); }
function nativeMoney(amount, currency = "TWD") {
  const size = Math.abs(number(amount)); const digits = !isCrypto(currency) ? 2 : size >= 1000 ? 2 : size >= 1 ? 4 : 8;
  return `${currencySymbol(currency)}${formatNumber(amount, digits)}`;
}
function moneyTWD(twd, compact = false) {
  let currency = state.settings.displayCurrency || "TWD";
  if (!rate(currency)) currency = "TWD";
  const digits = isCrypto(currency) ? 6 : compact || currency === "TWD" ? 0 : 2;
  return `${currencySymbol(currency)}${formatNumber(fromTWD(twd, currency), digits)}`;
}
// 這筆交易對「某個帳戶」的金額，一律換算成該帳戶自己的幣別（交易幣別 ≠ 帳戶幣別時依匯率換算）。
// 例：用 TWD 賣出 USDT，錢進一個幣別是 USDT 的帳戶 → 26,416 TWD 要換成約 801 USDT，不能直接當 26,416 USDT。
function sourceAmount(row, accountCurrency) {
  const p = row.p || {};
  if (p.收支 !== "轉帳" && number(p.實扣金額)) return number(p.實扣金額); // 信用卡帳單實扣（卡片幣別）
  let amount = number(p.原幣金額) || number(p.成交數量) * number(p.成交單價); let currency = p.幣別 || accountCurrency;
  if (!amount) { amount = number(p.台幣金額); currency = "TWD"; }
  return currency === accountCurrency ? amount : fromTWD(toTWD(amount, currency), accountCurrency);
}
function feeInAccount(row, accountCurrency) {
  const p = row.p || {}; const fee = number(p.手續費); if (!fee) return 0;
  const currency = p.幣別 || accountCurrency;
  return currency === accountCurrency ? fee : fromTWD(toTWD(fee, currency), accountCurrency);
}
function nativeAmount(record) {
  const p = record.p || {};
  return number(p.實扣金額 || p.原幣金額 || (number(p.成交數量) * number(p.成交單價)) || p.台幣金額);
}
function transactionTWD(record) {
  const p = record.p || {};
  if (p.台幣金額 !== null && p.台幣金額 !== undefined && p.台幣金額 !== "") return number(p.台幣金額);
  return toTWD(p.原幣金額 || number(p.成交數量) * number(p.成交單價), p.幣別 || "TWD");
}

function accountBalance(account) {
  const p = account.p || {};
  let balance = number(p.期初餘額);
  const openDate = p.開帳日 || "0000-01-01";
  for (const row of state.transactions) {
    const t = row.p || {};
    if ((t.日期 || "") < openDate) continue;
    const source = hasRelation(t.帳戶, account.id);
    const target = hasRelation(t.轉入帳戶, account.id);
    const accountCurrency = p.幣別 || "TWD";
    const amount = source ? sourceAmount(row, accountCurrency) : 0;
    const fee = source ? feeInAccount(row, accountCurrency) : 0;
    if (source) {
      if (t.收支 === "收入") balance += amount;
      else if (t.收支 === "支出" || t.收支 === "轉帳") balance -= amount;
      else if (t.收支 === "投資買入") balance -= amount + fee;
      else if (t.收支 === "投資賣出") balance += amount - fee;
      else if (t.收支 === "估值調整") balance += amount;
    }
    if (target && t.收支 === "轉帳") {
      const targetAmount = t.實扣金額 ? number(t.實扣金額) : fromTWD(transactionTWD(row), accountCurrency);
      balance += targetAmount;
    }
  }
  return balance;
}
function accountTWD(account) {
  const p = account.p || {};
  if (p.類型 === "保險") return INCLUDE_YES.includes(p.計入資產) || p.計入資產 === true ? toTWD(p.保單價值, p.幣別) : 0;
  return toTWD(accountBalance(account), p.幣別 || "TWD");
}
function holdingTWD(holding) { const p = holding.p || {}; return toTWD(number(p.數量) * number(p.最新價 ?? p.平均成本), p.計價幣別 || "TWD"); }
// 未實現損益：以「數量 ×（最新價 − 平均成本）」計算，單位為持倉的計價幣別
function holdingReturn(holding) {
  const p = holding.p || {}; const qty = number(p.數量); const avg = number(p.平均成本);
  const hasPrice = p.最新價 !== null && p.最新價 !== undefined && p.最新價 !== "";
  if (!(qty > 0) || !(avg > 0) || !hasPrice) return null;
  const cost = qty * avg; const value = qty * number(p.最新價);
  return { cost, value, pnl: value - cost, pct: (value - cost) / cost * 100 };
}
function signed(text, n) { return `${n > 0 ? "+" : n < 0 ? "−" : ""}${text}`; }
function percentText(pct) { return signed(`${formatNumber(Math.abs(pct), 2)}%`, pct); }
function totals() {
  const accountValues = state.accounts.filter((x) => x.p?.啟用 !== false).map((account) => ({ account, value: accountTWD(account) }));
  const investments = state.holdings.filter((x) => x.p?.啟用 !== false).reduce((sum, row) => sum + holdingTWD(row), 0);
  const assets = accountValues.filter((x) => x.value > 0).reduce((sum, x) => sum + x.value, 0) + investments;
  const liabilities = accountValues.filter((x) => x.value < 0).reduce((sum, x) => sum + Math.abs(x.value), 0);
  return { assets, liabilities, net: assets - liabilities, investments, accountValues };
}

function syncIdFor(record) { return record?.p?.同步編號 || record?.sync_id || record?.id?.replace(/^local-/, "") || uuid(); }
async function queueOperation(op) {
  const existing = await getOne("outbox", op.id);
  const merged = existing && op.op === "upsert"
    ? { ...existing, ...op, data: { ...(existing.data || {}), ...(op.data || {}) }, attempts: existing.attempts || 0, error: null }
    : { attempts: 0, created_at: nowISO(), ...op };
  await putOne("outbox", merged);
  await loadState();
}
async function saveRecord(table, data, existing = null) {
  const syncId = existing ? syncIdFor(existing) : data.同步編號 || uuid();
  const id = existing?.id || `local-${syncId}`;
  const p = { ...(existing?.p || {}), ...data };
  if (table !== "snapshots") p.同步編號 = p.同步編號 || syncId;
  const record = { id, edited: existing?.edited || null, p, pending: true };
  await putOne(table, record);
  await queueOperation({ id: syncId, op: "upsert", table, sync_id: syncId, record_id: id, base_edited: existing?.edited || null, data: p });
  await loadState(); render();
  if (navigator.onLine && state.settings.token) void pushOutbox();
  return record;
}
// 刪除（或記錯重記）一筆投資買賣：把當初對持倉造成的改變退回去。帳戶餘額是由交易算出來的，刪掉交易就自動回到原來的樣子。
async function revertHoldingFromTrade(t) {
  if (!t || !String(t.收支 || "").startsWith("投資") || !asArray(t.持倉).length) return;
  const holding = state.holdings.find((x) => hasRelation(t.持倉, x.id)); if (!holding) return;
  const qty = number(t.成交數量); const price = number(t.成交單價);
  let nextQty = number(holding.p?.數量); let nextAvg = number(holding.p?.平均成本);
  if (t.收支 === "投資賣出") nextQty += qty;
  else {
    const remain = nextQty - qty;
    if (remain > 0) nextAvg = Math.max(0, ((nextQty * nextAvg) - (qty * price)) / remain);
    nextQty = Math.max(0, remain);
  }
  await saveRecord("holdings", { 數量: roundedNumber(nextQty, 8), 平均成本: roundedNumber(nextAvg, 8) }, holding);
}
async function removeRecord(table, record) {
  if (table === "transactions") await revertHoldingFromTrade(record.p);
  const syncId = syncIdFor(record);
  if (table === "transactions") await deleteOne("meta", `receipt-${syncId}`);
  if (record.id.startsWith("local-")) {
    await deleteOne(table, record.id); await deleteOne("outbox", syncId);
  } else {
    await deleteOne(table, record.id);
    await queueOperation({ id: syncId, op: "delete", table, sync_id: syncId, record_id: record.id, base_edited: record.edited || null, data: {} });
  }
  await loadState(); render();
  if (navigator.onLine && state.settings.token) void pushOutbox();
}

function localDependencies(op) {
  const found = [];
  const walk = (value) => {
    if (typeof value === "string" && value.startsWith("local-")) found.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(op.data); return [...new Set(found)];
}
function replaceDeep(value, oldId, newId) {
  if (value === oldId) return newId;
  if (Array.isArray(value)) return value.map((x) => replaceDeep(x, oldId, newId));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceDeep(v, oldId, newId)]));
  return value;
}
async function replaceLocalId(oldId, newId) {
  for (const table of TABLES) {
    const rows = await getAll(table);
    for (const row of rows) {
      const changed = JSON.stringify(row).includes(oldId);
      if (!changed) continue;
      const next = replaceDeep(row, oldId, newId);
      if (row.id === oldId) await deleteOne(table, oldId);
      await putOne(table, next);
    }
  }
  for (const op of await getAll("outbox")) if (JSON.stringify(op).includes(oldId)) await putOne("outbox", replaceDeep(op, oldId, newId));
}

function apiHeaders() { return { "Content-Type": "application/json", "x-webhook-token": state.settings.token }; }
function endpoint(name) { return `${state.settings.baseUrl.replace(/\/$/, "")}/${name}`; }
async function pushOutbox() {
  if (state.syncing || !navigator.onLine || !state.settings.token) return;
  state.syncing = true; updateNetworkPill();
  try {
    let queue = await getAll("outbox");
    while (queue.length) {
      const ready = queue.filter((op) => localDependencies(op).length === 0).sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")).slice(0, 25);
      if (!ready.length) throw new Error("待送資料彼此參照，請先檢查帳戶或持倉關聯");
      const response = await fetch(endpoint("piggy-write"), { method: "POST", headers: apiHeaders(), body: JSON.stringify({ ops: ready.map(({ op, table, sync_id, record_id, base_edited, data }) => ({ op, table, sync_id, id: record_id, base_edited, data })) }) });
      if (!response.ok) throw new Error(`寫入服務回應 ${response.status}`);
      const payload = await response.json();
      let forceFull = false;
      for (const result of payload.results || []) {
        const op = ready.find((x) => x.sync_id === result.sync_id); if (!op) continue;
        if (["created", "duplicate", "updated", "deleted"].includes(result.status)) {
          if (op.record_id?.startsWith("local-") && result.id) await replaceLocalId(op.record_id, result.id);
          if (result.status !== "deleted" && result.id) {
            const row = await getOne(op.table, result.id);
            if (row) await putOne(op.table, { ...row, edited: result.edited || row.edited, pending: false });
          }
          await deleteOne("outbox", op.id);
        } else if (result.status === "conflict") {
          await deleteOne("outbox", op.id); forceFull = true;
          toast("另一台裝置已修改這筆資料，已保留較新的版本並重新同步");
        } else {
          const attempts = (op.attempts || 0) + 1;
          if (attempts >= 3) {
            await putOne("failed", { ...op, id: `${op.id}-${Date.now()}`, attempts, error: result.message || "寫入失敗" });
            await deleteOne("outbox", op.id);
          } else await putOne("outbox", { ...op, attempts, error: result.message || "寫入失敗" });
        }
      }
      if (forceFull) await pullSync(true);
      queue = await getAll("outbox");
    }
    await pullSync(false, true);
  } catch (error) {
    toast(`同步暫停：${error.message}`);
  } finally {
    state.syncing = false; await loadState(); render(); updateNetworkPill();
  }
}
async function pullSync(full = false, quiet = false) {
  if (!navigator.onLine || !state.settings.token) { if (!quiet) toast(state.settings.token ? "目前離線，資料會留在本機" : "請先在設定輸入連線碼"); return; }
  const stale = !state.lastSync || Date.now() - Date.parse(state.lastSync) > 12 * 3600 * 1000;
  const useFull = full || stale;
  const url = new URL(endpoint("piggy-sync"));
  if (useFull) url.searchParams.set("full", "1"); else if (state.lastSync) url.searchParams.set("since", state.lastSync);
  const response = await fetch(url, { headers: { "x-webhook-token": state.settings.token } });
  if (!response.ok) throw new Error(`讀取服務回應 ${response.status}`);
  const payload = await response.json();
  if (!payload.ok && payload.errors?.length) throw new Error(payload.errors[0]);
  const pendingIds = new Set((await getAll("outbox")).map((op) => op.sync_id));
  for (const table of TABLES) {
    const incoming = payload.data?.[table] || [];
    const preserved = (await getAll(table)).filter((row) => row.id.startsWith("local-") || pendingIds.has(syncIdFor(row)));
    if (payload.full) await clearStore(table);
    await putMany(table, [...incoming.filter((row) => !pendingIds.has(syncIdFor(row))), ...preserved]);
  }
  await putOne("meta", { id: "lastSync", value: payload.server_time || nowISO() });
  await loadState(); render();
  if (!quiet) toast("同步完成");
}
async function synchronize(full = false) {
  if (state.syncing) return;
  if (!state.settings.token) { switchView("more"); toast("請先在設定輸入連線碼；離線記帳仍可使用"); return; }
  try {
    if ((await getAll("outbox")).length) await pushOutbox();
    state.syncing = true; updateNetworkPill();
    await pullSync(full);
  }
  catch (error) { toast(`同步失敗：${error.message}`); }
  finally { state.syncing = false; updateNetworkPill(); }
}

function updateNetworkPill() {
  const pill = $("#network-pill");
  if (!pill) return;
  pill.textContent = state.syncing ? "同步中…" : navigator.onLine ? (state.outbox.length ? `${state.outbox.length} 筆待送` : "已連線") : "離線可用";
  pill.classList.toggle("offline", !navigator.onLine || state.outbox.length > 0);
}
function toast(message) {
  const el = document.createElement("div"); el.className = "toast"; el.textContent = message;
  $("#toast-region").append(el); setTimeout(() => el.remove(), 4200);
}
function switchView(view) {
  state.view = view;
  $$('[data-view]').forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  $$('[data-nav]').forEach((el) => el.classList.toggle("active", el.dataset.nav === view));
  $("#page-title").textContent = ({ overview: "總覽", accounts: "帳戶", investments: "投資", guide: "記帳說明", more: "固定支出與設定" })[view];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render() {
  renderHeader(); renderOverview(); renderAccounts(); renderHoldings(); renderRecurring(); renderSettings(); renderQueue(); updateNetworkPill();
}
function renderHeader() {
  $("#today-label").textContent = new Intl.DateTimeFormat("zh-TW", { dateStyle: "full", timeZone: "Asia/Taipei" }).format(new Date());
  $("#version-label").textContent = APP_VERSION;
  const incomplete = state.accounts.some((a) => a.p?.啟用 !== false && (!a.p?.開帳日 || a.p?.期初餘額 === null || a.p?.期初餘額 === undefined));
  $("#setup-mini").classList.toggle("attention", Boolean(state.accounts.length && incomplete));
}
function renderOverview() {
  const t = totals();
  $("#net-worth").textContent = moneyTWD(t.net);
  $("#total-assets").textContent = moneyTWD(t.assets, true);
  $("#total-liabilities").textContent = moneyTWD(t.liabilities, true);
  const month = todayISO().slice(0, 7);
  const expenses = state.transactions.filter((row) => row.p?.收支 === "支出" && String(row.p?.日期 || "").startsWith(month));
  const monthExpense = expenses.reduce((sum, row) => sum + transactionTWD(row), 0);
  $("#month-expense").textContent = moneyTWD(monthExpense, true);
  $("#pending-count").textContent = `${state.outbox.length} 筆`;
  $("#sync-status").textContent = state.lastSync ? `上次同步 ${new Date(state.lastSync).toLocaleString("zh-TW")}` : "尚未與雲端同步；可先離線使用";

  const allocation = new Map();
  for (const { account, value } of t.accountValues) if (value > 0) allocation.set(account.p?.類型 || "其他", (allocation.get(account.p?.類型 || "其他") || 0) + value);
  if (t.investments > 0) allocation.set("投資", (allocation.get("投資") || 0) + t.investments);
  renderDonut([...allocation.entries()]);

  const categories = new Map();
  expenses.forEach((row) => categories.set(row.p?.分類 || "未分類", (categories.get(row.p?.分類 || "未分類") || 0) + transactionTWD(row)));
  renderExpenseBars([...categories.entries()], monthExpense);
  const recent = [...state.transactions].sort((a, b) => String(b.p?.日期 || "").localeCompare(String(a.p?.日期 || ""))).slice(0, 8);
  const list = $("#recent-transactions");
  list.classList.toggle("empty-state", !recent.length);
  list.innerHTML = recent.length ? recent.map(transactionRow).join("") : "還沒有交易，記下第一筆吧！";
  renderTrend(t.net);
}
function renderTrend(currentNet) {
  const byDate = new Map(state.snapshots.map((row) => [row.p?.日期 || row.p?.快照日, number(row.p?.淨資產TWD ?? row.p?.淨資產)]).filter(([date]) => date));
  byDate.set(todayISO(), currentNet);
  const rows = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-30);
  const el = $("#net-worth-trend"); if (!el) return;
  if (rows.length < 2) { el.classList.add("empty-state"); el.textContent = "累積兩天快照後顯示"; return; }
  el.classList.remove("empty-state");
  const values = rows.map(([, value]) => value); const min = Math.min(...values); const max = Math.max(...values); const spread = Math.max(1, max - min);
  const points = rows.map(([, value], i) => `${20 + i * 760 / Math.max(1, rows.length - 1)},${185 - (value - min) / spread * 155}`).join(" ");
  const last = points.split(" ").at(-1).split(",");
  el.innerHTML = `<svg viewBox="0 0 800 210" role="img" aria-label="淨資產趨勢"><defs><linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f38ba0" stop-opacity=".3"/><stop offset="1" stop-color="#f38ba0" stop-opacity="0"/></linearGradient></defs><line class="trend-grid" x1="20" y1="30" x2="780" y2="30"/><line class="trend-grid" x1="20" y1="185" x2="780" y2="185"/><polygon class="trend-area" points="20,195 ${points} 780,195"/><polyline class="trend-line" points="${points}"/><circle class="trend-dot" cx="${last[0]}" cy="${last[1]}" r="6"/></svg><div class="trend-labels"><span>${esc(rows[0][0])}</span><strong>${moneyTWD(values.at(-1))}</strong><span>${esc(rows.at(-1)[0])}</span></div>`;
}
function renderDonut(entries) {
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  let cursor = 0; const segments = [];
  entries.forEach(([, value], i) => { const end = cursor + (value / total) * 100; segments.push(`${COLORS[i % COLORS.length]} ${cursor}% ${end}%`); cursor = end; });
  $("#asset-donut").style.setProperty("--segments", `conic-gradient(${segments.length ? segments.join(",") : "#eee 0 100%"})`);
  $("#asset-legend").innerHTML = entries.length ? entries.map(([name, value], i) => `<li><i class="legend-dot" style="background:${COLORS[i % COLORS.length]}"></i>${esc(name)} <strong>${Math.round(value / total * 100)}%</strong></li>`).join("") : "<li>完成開帳後顯示</li>";
}
function renderExpenseBars(entries, total) {
  const el = $("#expense-bars"); $("#expense-total-label").textContent = total ? moneyTWD(total, true) : "";
  el.classList.toggle("empty-state", !entries.length);
  const max = Math.max(1, ...entries.map(([, value]) => value));
  el.innerHTML = entries.length ? entries.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, value]) => `<div class="bar-row"><span>${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${value / max * 100}%"></div></div><strong>${moneyTWD(value, true)}</strong></div>`).join("") : "還沒有本月支出";
}
function transactionRow(row) {
  const p = row.p || {}; const sign = p.收支 === "收入" || p.收支 === "投資賣出" ? "+" : p.收支 === "估值調整" ? "±" : "−";
  return `<div class="list-item" data-edit="transaction" data-id="${esc(row.id)}"><div class="item-main"><span class="item-icon">${p.收支 === "收入" ? "💰" : p.收支?.startsWith("投資") ? "📈" : p.收支 === "轉帳" ? "↔️" : "🧾"}</span><div><div class="item-title">${esc(p["店家／項目"] || p.收支 || "交易")}${state.receiptIds.has(`receipt-${syncIdFor(row)}`) ? ' <span title="有收據照片">📎</span>' : ""}${row.pending ? '<span class="pending-badge">待送</span>' : ""}</div><div class="item-meta">${esc(p.日期 || "")} · ${esc(p.分類 || p.幣別 || "")}</div></div></div><div class="amount ${p.收支 === "支出" ? "expense" : ""}">${sign}${moneyTWD(transactionTWD(row), true)}</div></div>`;
}
function renderAccounts() {
  const groups = new Map(); state.accounts.filter((x) => x.p?.啟用 !== false).forEach((row) => { const type = row.p?.類型 || "其他"; if (!groups.has(type)) groups.set(type, []); groups.get(type).push(row); });
  const el = $("#account-groups"); el.classList.toggle("empty-state", !state.accounts.length);
  el.innerHTML = groups.size ? [...groups.entries()].map(([type, rows]) => `<section><h2 class="group-title">${esc(type)}</h2><div class="group-card">${rows.map((row) => `<div class="account-row" data-edit="account" data-id="${esc(row.id)}"><div class="item-main"><span class="item-icon">${iconFor(type)}</span><div><div class="account-name">${esc(row.p?.名稱 || "未命名")}${row.pending ? '<span class="pending-badge">待送</span>' : ""}</div><div class="item-meta">${esc(row.p?.幣別 || "TWD")}${type === "信用卡" ? ` · 結帳 ${esc(row.p?.結帳日 || "－")} 日／繳款 ${esc(row.p?.繳款日 || "－")} 日` : ""}</div></div></div><div class="account-balance">${moneyTWD(accountTWD(row))}<div class="item-meta">${nativeMoney(accountBalance(row), row.p?.幣別 || "TWD")}</div>${type === "信用卡" ? `<div class="account-actions"><button type="button" class="secondary" data-card-action="reconcile" data-id="${esc(row.id)}">對帳</button><button type="button" data-card-action="pay" data-id="${esc(row.id)}">繳卡費</button></div>` : ""}</div></div>`).join("")}</div></section>`).join("") : "尚無帳戶";
}
function renderHoldings() {
  const sumReturn = (rows) => {
    let cost = 0; let value = 0; let total = 0;
    for (const row of rows) { total += holdingTWD(row); const r = holdingReturn(row); if (r) { const cur = row.p?.計價幣別 || "TWD"; cost += toTWD(r.cost, cur); value += toTWD(r.value, cur); } }
    return { total, cost, pnl: value - cost };
  };
  const returnText = (x) => x.cost > 0 ? `<small class="return ${x.pnl >= 0 ? "gain" : "loss"}">損益 ${signed(moneyTWD(Math.abs(x.pnl)), x.pnl)}（${percentText(x.pnl / x.cost * 100)}）</small>` : "";
  const all = sumReturn(state.holdings);
  $("#holding-total").innerHTML = `總現值 ${moneyTWD(all.total)}${all.cost > 0 ? `<small class="return ${all.pnl >= 0 ? "gain" : "loss"}">未實現損益 ${signed(moneyTWD(Math.abs(all.pnl)), all.pnl)}（${percentText(all.pnl / all.cost * 100)}）</small>` : ""}`;
  const el = $("#holding-list"); el.classList.toggle("empty-state", !state.holdings.length);
  if (!state.holdings.length) { el.innerHTML = "尚無持倉"; return; }
  const groups = new Map();
  for (const row of state.holdings) { const key = holdingPlatform(row) || "未指定平台"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  const card = (row) => {
    const p = row.p || {}; const currency = p.計價幣別 || "TWD"; const r = holdingReturn(row);
    const returnLine = r
      ? `<div class="hc-line"><span>成本 ${nativeMoney(r.cost, currency)}</span><strong class="return ${r.pnl >= 0 ? "gain" : "loss"}">${signed(nativeMoney(Math.abs(r.pnl), currency), r.pnl)}（${percentText(r.pct)}）</strong></div>`
      : `<div class="hc-line"><span>填入數量、平均成本後顯示報酬率</span></div>`;
    const icon = row.pending ? '<span class="pending-badge">待送</span>' : "";
    return `<article class="holding-card compact" data-edit="holding" data-id="${esc(row.id)}"><div class="hc-top"><div class="hc-name"><b>${esc(p.名稱 || "未命名")}</b><small>${esc(p.代號 || p.市場 || "")}</small></div><div class="hc-value">${icon}${moneyTWD(holdingTWD(row))}</div></div><div class="hc-line"><span>${formatNumber(p.數量, 8)} × ${nativeMoney(p.最新價 ?? p.平均成本, currency)}</span></div>${returnLine}<div class="hc-foot"><span class="${p.報價來源 ? "price-ok" : "price-warn"}">${esc(p.報價來源 || "手動價格")}</span><span>${esc(String(p.價格更新時間 || "尚未更新").slice(0, 16).replace("T", " "))}</span></div></article>`;
  };
  el.innerHTML = [...groups.entries()].map(([platform, rows]) => ({ platform, rows: rows.sort((a, b) => holdingTWD(b) - holdingTWD(a)), ...sumReturn(rows) })).sort((a, b) => b.total - a.total)
    .map((g) => `<section class="holding-group"><header class="group-head"><h3>${esc(g.platform)}<small>${g.rows.length} 檔</small></h3><div class="group-sum"><b>${moneyTWD(g.total)}</b>${returnText(g)}</div></header><div class="card-grid compact">${g.rows.map(card).join("")}</div></section>`).join("");
}
function monthlyEquivalent(p) { const amount = toTWD(p.金額, p.幣別); return p.週期 === "年" ? amount / 12 : p.週期 === "季" ? amount / 3 : p.週期 === "週" ? amount * 52 / 12 : amount; }
function renderRecurring() {
  const active = state.recurring.filter((x) => x.p?.啟用 !== false); $("#monthly-recurring").textContent = moneyTWD(active.filter((x) => x.p?.性質 !== "轉入資產").reduce((sum, x) => sum + monthlyEquivalent(x.p || {}), 0));
  const el = $("#recurring-list"); el.classList.toggle("empty-state", !active.length);
  el.innerHTML = active.length ? active.map((row) => `<div class="list-item" data-edit="recurring" data-id="${esc(row.id)}"><div class="item-main"><span class="item-icon">📅</span><div><div class="item-title">${esc(row.p?.名稱 || "固定支出")}${row.pending ? '<span class="pending-badge">待送</span>' : ""}</div><div class="item-meta">${esc(row.p?.週期 || "月")} · ${esc(row.p?.性質 || "支出")}</div></div></div><strong>${nativeMoney(row.p?.金額, row.p?.幣別 || "TWD")}</strong></div>`).join("") : "尚無固定支出";
}
function renderSettings(force = false) {
  const form = $("#settings-form"); if (!form) return;
  // 正在輸入設定時不要重畫，避免背景同步把還沒儲存的內容洗掉
  if (!force && form.contains(document.activeElement) && document.activeElement.matches("input,select")) return;
  const list = currencyList();
  form.elements.displayCurrency.innerHTML = list.map((item) => `<option>${esc(item.code)}</option>`).join("");
  $("#rate-fields").innerHTML = list.filter((item) => item.code !== "TWD").map((item) => `<label class="rate-row"><span>${esc(item.code)}<small>${item.kind === "crypto" ? "加密貨幣" : "法幣"}${rate(item.code) ? "" : " · 尚未取得匯率"}</small></span><input name="rate${esc(item.code)}" type="number" min="0" step="any" placeholder="按「更新匯率與報價」自動帶入">${item.builtin ? "<i></i>" : `<button type="button" class="danger" data-action="remove-currency" data-code="${esc(item.code)}" aria-label="移除 ${esc(item.code)}">移除</button>`}</label>`).join("");
  for (const [key, value] of Object.entries(state.settings)) if (form.elements[key] && typeof value !== "object") form.elements[key].value = value ?? "";
  if (!list.some((item) => item.code === state.settings.displayCurrency)) form.elements.displayCurrency.value = "TWD";
}
function readRateInputs() {
  const form = $("#settings-form"); const rates = {};
  for (const code of currencyCodes()) { if (code === "TWD") continue; const input = form.elements[`rate${code}`]; if (input && input.value !== "") rates[`rate${code}`] = number(input.value); }
  return rates;
}
async function addCurrency(codeArg, kindArg) {
  const code = String(codeArg ?? $("#new-currency-code").value).trim().toUpperCase(); const kind = (kindArg ?? $("#new-currency-kind").value) === "fiat" ? "fiat" : "crypto";
  if (!/^[A-Z0-9]{2,10}$/.test(code)) return toast("幣別代號請填 2～10 個英數字，例如 SOL、EUR");
  if (currencyCodes().includes(code)) return toast(`${code} 已經在幣別清單裡`);
  const wasBuiltin = [...FIAT_CURRENCIES, ...CRYPTO_CURRENCIES].includes(code);
  state.settings = { ...state.settings, ...readRateInputs(), hiddenCurrencies: asArray(state.settings.hiddenCurrencies).filter((c) => c !== code), currencies: wasBuiltin ? customCurrencies() : [...customCurrencies(), { code, kind }] };
  await putOne("meta", state.settings); await loadState(); render(); renderSettings(true);
  $("#new-currency-code").value = ""; toast(`已新增幣別 ${code}`);
  if (navigator.onLine) void refreshPrices(); else toast("目前離線，請先手動填匯率");
}
async function removeCurrency(code) {
  if (code === "TWD") return toast("台幣是基準幣別，不能移除");
  if (optionUsedCount("currency", code)) return toast(`還有帳戶、持倉、固定支出或交易使用 ${code}，無法移除`);
  if (!confirm(`確定移除幣別 ${code}？`)) return;
  const builtin = [...FIAT_CURRENCIES, ...CRYPTO_CURRENCIES].includes(code);
  const settings = { ...state.settings, ...readRateInputs(), hiddenCurrencies: builtin ? [...new Set([...asArray(state.settings.hiddenCurrencies), code])] : asArray(state.settings.hiddenCurrencies), currencies: customCurrencies().filter((item) => item.code !== code) };
  delete settings[`rate${code}`]; if (settings.displayCurrency === code) settings.displayCurrency = "TWD";
  state.settings = settings; await putOne("meta", settings); await loadState(); render(); renderSettings(true); toast(`已移除幣別 ${code}`);
}
// ---- 下拉選單的「新增／刪除選項」視窗 ----
function openOptionsDialog(key) { state.optionsKey = key; renderOptionsDialog(); $("#options-dialog").showModal(); }
function refreshEditorAfterOptions() { if (state.editor) { state.editor.draft = { ...state.editor.draft, ...collectEditorData() }; renderEditorFields(); } }
function renderOptionsDialog() {
  const key = state.optionsKey; if (!key) return; $("#options-title").textContent = `管理「${OPTION_LABEL[key]}」選項`;
  const rows = key === "currency" ? currencyList().map((i) => ({ value: i.code, note: i.kind === "crypto" ? "加密貨幣" : "法幣", locked: i.code === "TWD" })) : optionList(key).map((value) => ({ value }));
  const adder = key === "currency"
    ? `<div class="option-add"><input id="options-new" placeholder="代號，例如 EUR、SOL" maxlength="10"><select id="options-kind"><option value="fiat">法幣</option><option value="crypto">加密貨幣</option></select><button type="button" data-options-add>新增</button></div><p class="source-note">新增後匯率會自動抓；查不到時到「更多 → 設定」手動填。</p>`
    : `<div class="option-add"><input id="options-new" placeholder="輸入新的${esc(OPTION_LABEL[key])}" maxlength="20"><button type="button" data-options-add>新增</button></div>`;
  $("#options-body").innerHTML = `<div class="option-list">${rows.map((row) => { const used = row.locked ? 0 : optionUsedCount(key, row.value);
    return `<div class="option-row"><span>${esc(row.value)}${row.note ? `<small>${esc(row.note)}</small>` : ""}</span>${row.locked ? "<i>基準</i>" : used ? `<small>使用中 ${used} 筆</small>` : `<button type="button" class="danger" data-options-delete="${esc(row.value)}">刪除</button>`}</div>`; }).join("") || '<div class="empty-state">沒有選項</div>'}</div>${adder}<p class="source-note">「使用中」的選項不能刪；新增的值會隨資料同步到 Notion（Notion 會自動長出新選項）。</p>`;
}
async function saveOptionList(key, next) {
  state.settings = { ...state.settings, options: { ...(state.settings.options || {}), [key]: next } };
  await putOne("meta", state.settings); await loadState(); render(); renderOptionsDialog(); refreshEditorAfterOptions();
}
async function optionsAdd() {
  const key = state.optionsKey; const raw = $("#options-new").value.trim();
  if (!raw) return toast("請先輸入名稱");
  if (key === "currency") { await addCurrency(raw, $("#options-kind").value); renderOptionsDialog(); refreshEditorAfterOptions(); return; }
  if (raw.length > 20) return toast("名稱請在 20 字以內");
  if (optionList(key).includes(raw)) return toast(`「${raw}」已經在清單裡`);
  const { add, remove } = optionState(key);
  await saveOptionList(key, { add: [...add.filter((v) => v !== raw), raw], remove: remove.filter((v) => v !== raw) }); toast(`已新增「${raw}」`);
}
async function optionsDelete(value) {
  const key = state.optionsKey;
  if (key === "currency") { await removeCurrency(value); renderOptionsDialog(); refreshEditorAfterOptions(); return; }
  if (optionUsedCount(key, value)) return toast(`「${value}」還有 ${optionUsedCount(key, value)} 筆資料使用，無法刪除`);
  if (!confirm(`確定刪除選項「${value}」？`)) return;
  const { add, remove } = optionState(key);
  await saveOptionList(key, { add: add.filter((v) => v !== value), remove: OPTION_BASE[key].includes(value) ? [...new Set([...remove, value])] : remove }); toast(`已刪除「${value}」`);
}
let coinSearchTimer = null;
async function searchCoins(query) {
  const box = $("#coin-results"); if (!box) return;
  const q = String(query || "").trim(); if (q.length < 2) { box.innerHTML = ""; return; }
  if (!navigator.onLine) { box.innerHTML = '<div class="source-note">目前離線，無法搜尋。</div>'; return; }
  box.innerHTML = '<div class="source-note">搜尋中…</div>';
  try {
    const found = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`).then((r) => { if (!r.ok) throw new Error(`CoinGecko 回應 ${r.status}`); return r.json(); });
    const coins = (found?.coins || []).slice(0, 8);
    box.innerHTML = coins.length ? coins.map((c) => `<button type="button" class="coin-option" data-coin-id="${esc(c.id)}" data-coin-name="${esc(c.name)}" data-coin-symbol="${esc(String(c.symbol || "").toUpperCase())}">${c.thumb ? `<img src="${esc(c.thumb)}" alt="" width="20" height="20">` : ""}<span><b>${esc(c.name)}</b> <small>${esc(String(c.symbol || "").toUpperCase())}${c.market_cap_rank ? ` · 市值第 ${esc(c.market_cap_rank)}` : ""}</small></span></button>`).join("") : '<div class="source-note">找不到，換個名稱或代號試試。</div>';
  } catch (error) { box.innerHTML = `<div class="source-note">搜尋失敗：${esc(error.message)}</div>`; }
}
function pickCoin(button) {
  const d = button.dataset; const draft = { ...state.editor.draft, ...collectEditorData() };
  draft.代號 = `cg:${d.coinId}`; draft.名稱 = `${d.coinName} (${d.coinSymbol})`; draft.市場 = "加密貨幣"; if (!draft.計價幣別) draft.計價幣別 = "USD";
  state.editor.draft = draft; renderEditorFields(); toast(`已選擇 ${d.coinName}`);
}
let twStocksCache = null;
async function loadTwStocks() {
  if (twStocksCache) return twStocksCache;
  try {
    const response = await fetch("https://chaiowei.github.io/pocket-piggy/data/tw-stocks.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    twStocksCache = await response.json(); await putOne("meta", { id: "tw-stocks", data: twStocksCache });
  } catch (error) { twStocksCache = (await getOne("meta", "tw-stocks"))?.data || null; }
  return twStocksCache;
}
function twStockPrice(list, code) { const row = list?.rows?.find((x) => x[0] === String(code || "").trim().toUpperCase()); return row ? { code: row[0], name: row[1], price: row[2], board: row[3] } : null; }
async function searchTwStocks(query) {
  const box = $("#stock-results"); if (!box) return;
  const q = String(query || "").trim().toUpperCase(); if (!q) { box.innerHTML = ""; return; }
  box.innerHTML = '<div class="source-note">搜尋中…</div>';
  const list = await loadTwStocks();
  if (!list) { box.innerHTML = '<div class="source-note">目前讀不到台股清單（需要連網一次）。</div>'; return; }
  const hits = list.rows.filter((r) => r[0].startsWith(q) || r[1].toUpperCase().includes(q)).slice(0, 10);
  box.innerHTML = hits.length ? hits.map((r) => `<button type="button" class="coin-option" data-stock-code="${esc(r[0])}"><span><b>${esc(r[1])}</b> <small>${esc(r[0])} · ${r[3] === "櫃" ? "上櫃" : "上市"}${r[2] ? ` · 收盤 ${esc(r[2])}` : ""}</small></span></button>`).join("") : '<div class="source-note">找不到。可以輸入代號（例如 3293、006208）或名稱的一部分（例如 台積）。</div>';
}
function pickTwStock(button) {
  const list = twStocksCache; const hit = twStockPrice(list, button.dataset.stockCode); if (!hit) return;
  const draft = { ...state.editor.draft, ...collectEditorData(), 市場: "台股", 代號: hit.code, 名稱: `${hit.name} (${hit.code})`, 計價幣別: "TWD" };
  if (hit.price) { draft.最新價 = hit.price; draft.報價來源 = hit.board === "櫃" ? "櫃買中心" : "證交所"; draft.價格更新時間 = nowISO(); }
  state.editor.draft = draft; renderEditorFields(); toast(`已選擇 ${hit.name}`);
}
async function verifySymbol() {
  const out = $("#verify-status"); const data = collectEditorData(); const symbol = String(data.代號 || "").trim();
  if (data.市場 === "台股") { const hit = twStockPrice(await loadTwStocks(), symbol); if (hit) { state.editor.draft = { ...state.editor.draft, ...data, 名稱: data.名稱 || `${hit.name} (${hit.code})`, 最新價: hit.price ?? data.最新價, 報價來源: hit.board === "櫃" ? "櫃買中心" : "證交所" }; renderEditorFields(); return; } }
  if (!symbol) { if (out) out.textContent = "請先填代號"; return; }
  if (!state.settings.token) { if (out) out.textContent = "需要先在「更多 → 設定」輸入連線碼"; return; }
  if (out) out.textContent = "查詢中…";
  try {
    const response = await fetch(endpoint("piggy-prices"), { method: "POST", headers: apiHeaders(), body: JSON.stringify({ holdings: [{ id: "verify", name: data.名稱, symbol, market: data.市場, currency: data.計價幣別 || "TWD" }] }) });
    if (!response.ok) throw new Error(`服務回應 ${response.status}`);
    const quote = ((await response.json()).quotes || [])[0];
    if (quote?.price) {
      const draft = { ...state.editor.draft, ...collectEditorData(), 最新價: roundedNumber(quote.price, 8), 報價來源: quote.source };
      if (!draft.名稱 && quote.name) draft.名稱 = quote.name;
      if (data.市場 === "美股" && !draft.計價幣別) draft.計價幣別 = "USD"; if (data.市場 === "台股" && !draft.計價幣別) draft.計價幣別 = "TWD";
      state.editor.draft = draft; renderEditorFields(); const note = $("#verify-status"); if (note) note.textContent = `✓ ${quote.name ? quote.name + " · " : ""}現價 ${quote.price}（${quote.source}）`;
    } else if (out) out.textContent = `✗ ${quote?.status || "查不到"}`;
  } catch (error) { if (out) out.textContent = `查詢失敗：${error.message}`; }
}
function renderQueue() {
  const rows = [...state.outbox.map((x) => ({ ...x, failed: false })), ...state.failed.map((x) => ({ ...x, failed: true }))];
  const el = $("#queue-list"); el.classList.toggle("empty-state", !rows.length);
  el.innerHTML = rows.length ? rows.map((row) => `<div class="list-item"><div><div class="item-title">${esc(({ accounts: "帳戶", holdings: "持倉", recurring: "固定支出", transactions: "交易" })[row.table] || row.table)}${row.failed ? '<span class="error-badge">失敗</span>' : '<span class="pending-badge">待送</span>'}</div><div class="item-meta">${esc(row.data?.名稱 || row.data?.["店家／項目"] || row.sync_id)}${row.error ? ` · ${esc(row.error)}` : ""}</div></div><strong>${row.attempts || 0}/3</strong></div>`).join("") : "目前沒有待送資料";
}

const field = (name, label, type = "text", options = {}) => ({ name, label, type, ...options });
const accountFields = [field("名稱", "名稱"), field("類型", "類型", "select", { choices: () => optionList("type"), manage: "type" }), field("幣別", "幣別", "select", { choices: currencyCodes, manage: "currency" }), field("國家", "國家", "select", { choices: () => optionList("country"), manage: "country" }), field("期初餘額", "期初餘額", "number"), field("開帳日", "開帳日", "date"), field("結帳日", "信用卡結帳日（每月幾號，1～31）", "number", { accountTypes: ["信用卡"], min: 1, max: 31, step: 1 }), field("繳款日", "信用卡繳款日（每月幾號，1～31）", "number", { accountTypes: ["信用卡"], min: 1, max: 31, step: 1 }), field("已出帳金額", "已出帳金額", "number", { accountTypes: ["信用卡"] }), field("保險種類", "保險種類", "select", { choices: () => optionList("insurance"), manage: "insurance", accountTypes: ["保險"] }), field("計入資產", "保險是否計入資產", "select", { choices: ["計入資產", "不計入（純保障）"], accountTypes: ["保險"] }), field("保單價值", "保單價值", "number", { accountTypes: ["保險"] }), field("啟用", "啟用", "checkbox", { default: true }), field("備註", "備註", "textarea", { wide: true })];
const holdingFields = [field("名稱", "名稱"), field("代號", "代號"), field("市場", "市場", "select", { choices: ["台股", "美股", "泰國基金", "加密貨幣", "其他"] }), field("計價幣別", "計價幣別", "select", { choices: currencyCodes, manage: "currency" }), field("數量", "數量", "number"), field("平均成本", "平均成本", "number"), field("最新價", "最新價（自動報價，可手動改）", "number"), field("帳戶", "所屬帳戶（放這個持倉的平台）", "relation", { source: "accounts", kinds: (d) => d.市場 === "加密貨幣" ? ["加密貨幣"] : d.市場 === "其他" || !d.市場 ? ["投資", "加密貨幣", "銀行"] : ["投資"] }), field("定期定額", "定期定額", "checkbox"), field("每期金額", "每期金額", "number"), field("扣款日", "扣款日（每月幾號，1～31）", "number", { min: 1, max: 31, step: 1 }), field("扣款帳戶", "扣款帳戶", "relation", { source: "accounts", kinds: () => ["銀行", "現金", "電子支付", "信用卡"] }), field("啟用", "啟用", "checkbox", { default: true }), field("備註", "備註", "textarea", { wide: true })];
const recurringFields = [field("名稱", "名稱"), field("群組", "群組"), field("週期", "週期", "select", { choices: ["週", "月", "季", "年"] }), field("金額", "金額", "number"), field("幣別", "幣別", "select", { choices: currencyCodes, manage: "currency" }), field("性質", "性質", "select", { choices: ["支出", "轉入資產"] }), field("扣款日", "扣款日（每月幾號，1～31）", "number", { min: 1, max: 31, step: 1 }), field("扣款月份", "扣款月份（1～12）", "number", { min: 1, max: 12, step: 1 }), field("扣款帳戶", "扣款帳戶", "relation", { source: "accounts", kinds: () => ["銀行", "現金", "電子支付", "信用卡"] }), field("下次扣款", "下次扣款", "date"), field("對應持倉", "對應持倉", "relation", { source: "holdings" }), field("啟用", "啟用", "checkbox", { default: true }), field("備註", "備註", "textarea", { wide: true })];
const transactionFields = [field("收支", "類型", "hidden"), field("店家／項目", "店家／項目"), field("日期", "日期", "date"), field("原幣金額", "金額", "number"), field("幣別", "幣別", "select", { choices: currencyCodes, manage: "currency" }), field("帳戶", "帳戶", "relation", { source: "accounts", kinds: (d, t) => t === "支出" ? ["銀行", "現金", "電子支付", "信用卡"] : ["銀行", "現金", "電子支付", "投資", "加密貨幣"] }), field("分類", "分類", "select", { choices: ["餐飲", "交通", "購物", "居住", "娛樂", "醫療", "旅遊", "薪資", "投資", "保險", "其他"] }), field("狀態", "狀態", "select", { choices: ["預估", "已入帳", "已出帳", "已繳款"] }), field("轉入帳戶", "轉入帳戶", "relation", { source: "accounts", types: ["轉帳"], kinds: () => ["銀行", "現金", "電子支付", "投資", "加密貨幣", "信用卡", "保險"] }), field("實扣金額", "實扣金額", "number", { types: ["轉帳", "支出"] }), field("持倉", "持倉", "relation", { source: "holdings", types: ["投資買入", "投資賣出"] }), field("成交數量", "成交數量", "number", { types: ["投資買入", "投資賣出"] }), field("成交單價", "成交單價", "number", { types: ["投資買入", "投資賣出"] }), field("手續費", "手續費", "number", { types: ["投資買入", "投資賣出"] }), field("定期定額", "定期定額", "checkbox", { types: ["投資買入"] }), field("備註", "備註", "textarea", { wide: true })];

function openEditor(kind, record = null, draft = {}) {
  state.editor = { kind, record, draft, transactionType: draft.收支 || record?.p?.收支 || "支出", receiptStatus: "", receiptImage: null, receiptRemoved: false };
  if (kind === "transaction" && record) {
    const editor = state.editor;
    void getOne("meta", `receipt-${syncIdFor(record)}`).then((saved) => {
      if (!saved?.image || state.editor !== editor || editor.receiptImage || editor.receiptRemoved) return;
      editor.draft = { ...editor.draft, ...collectEditorData() }; editor.receiptImage = saved.image; renderEditorFields();
    }).catch(() => {});
  }
  $("#editor-title").textContent = `${record ? "編輯" : "新增"}${({ account: "帳戶", holding: "持倉", recurring: "固定支出", transaction: "交易" })[kind]}`;
  $("#delete-button").classList.toggle("hidden", !record);
  $("#receipt-button").classList.toggle("hidden", kind !== "transaction"); $("#receipt-gallery-button").classList.toggle("hidden", kind !== "transaction");
  renderEditorFields(); $("#editor-dialog").showModal();
}
function renderEditorFields() {
  const { kind, record, transactionType } = state.editor; const data = { ...(record?.p || {}), ...(state.editor.draft || {}) }; state.editor.currentData = data;
  const fields = kind === "account" ? accountFields : kind === "holding" ? holdingFields : kind === "recurring" ? recurringFields : transactionFields;
  const tabs = kind === "transaction" ? `<div class="type-tabs">${["支出", "收入", "轉帳", "投資買入", "投資賣出"].map((type) => `<button type="button" data-transaction-type="${type}" class="${type === transactionType ? "active" : ""}">${type}</button>`).join("")}</div>` : "";
  const receipt = kind === "transaction" ? `<div class="receipt-tools"><strong>📷 收據 AI 辨識</strong>　可以「拍照」或「從相簿選」一張收據；辨識後只會先填表，不會自動儲存，請確認金額與帳戶。${state.editor.receiptStatus ? `<br><span id="receipt-status-text">${esc(state.editor.receiptStatus)}</span>` : ""}</div>` : "";
  const preview = kind === "transaction" && state.editor.receiptImage ? `<figure class="receipt-preview"><figcaption><span><strong>🧾 收據照片</strong>　對照上方欄位核對；照片只存在這台裝置。</span><button type="button" class="secondary" data-action="remove-receipt">移除照片</button></figcaption><img src="${esc(state.editor.receiptImage)}" alt="收據照片"></figure>` : "";
  $("#editor-fields").innerHTML = tabs + receipt + editorHint(kind, data, record) + fields.filter((f) => f.type !== "hidden" && (!f.types || f.types.includes(transactionType)) && (!f.accountTypes || f.accountTypes.includes(data.類型))).map((f) => renderField(f, data[f.name])).join("") + preview + (kind === "transaction" ? `<input type="hidden" name="收支" value="${esc(transactionType)}">` : "");
}
const STABLE_COINS = ["USDT", "USDC", "DAI", "USDD"];
function holdingPicker(data) {
  if (data.市場 === "加密貨幣") {
    const code = String(data.代號 || "").trim();
    return `<div class="receipt-tools coin-picker"><strong>🔎 選擇加密貨幣</strong>　輸入名稱或代號搜尋，點選後會自動帶入名稱與報價編號。${code ? `<br>目前：<b>${esc(data.名稱 || "")}</b> · 代號 <code>${esc(code)}</code>` : ""}<input id="coin-search" placeholder="例如 bitcoin、BTC、solana" autocomplete="off"><div id="coin-results" class="coin-results"></div></div>`;
  }
  if (data.市場 === "台股") {
    return `<div class="receipt-tools coin-picker"><strong>🔎 搜尋台股</strong>　輸入代號或名稱（上市、上櫃、ETF 都查得到），點選後自動帶入名稱與收盤價。${data.代號 ? `<br>目前：<b>${esc(data.名稱 || "")}</b> · 代號 <code>${esc(data.代號)}</code>` : ""}<input id="stock-search" placeholder="例如 3293、006208、台積" autocomplete="off"><div id="stock-results" class="coin-results"></div></div>`;
  }
  if (data.市場 === "美股") {
    return `<div class="receipt-tools"><strong>🔎 ${esc(data.市場)}</strong>　輸入代號（${data.市場 === "台股" ? "例如 0050、2330" : "例如 VT、AAPL"}），按「查價驗證」確認代號正確並取得現價${data.市場 === "台股" ? "與名稱" : ""}。<div class="option-add"><button type="button" class="secondary" data-action="verify-symbol">查價驗證</button><span id="verify-status" class="source-note"></span></div></div>`;
  }
  return "";
}
function duplicateHint(kind, data) {
  if (kind === "holding" && data.市場 === "加密貨幣") {
    const sym = cryptoSymbol(data.代號).replace(/^cg:/, "").toUpperCase(); const nameSym = (String(data.名稱 || "").match(/\(([A-Za-z0-9]+)\)/) || [])[1]?.toUpperCase() || sym;
    if (STABLE_COINS.includes(nameSym)) return `<div class="receipt-tools warn">⚠ ${esc(nameSym)} 是穩定幣，建議記在「交易所帳戶」並把帳戶幣別設成 ${esc(nameSym)}；放在持倉也可以，但<b>同一筆不要兩邊都記</b>，否則會算兩次。</div>`;
    if (currencyCodes().includes(nameSym) && state.accounts.some((a) => a.p?.幣別 === nameSym && (number(a.p?.期初餘額) || 0) !== 0)) return `<div class="receipt-tools warn">⚠ 已經有帳戶用 ${esc(nameSym)} 當幣別並填了餘額；同一筆幣不要在帳戶與持倉各記一次，否則會算兩次。</div>`;
  }
  if (kind === "account" && isCrypto(data.幣別) && !STABLE_COINS.includes(data.幣別)) return `<div class="receipt-tools warn">⚠ ${esc(data.幣別)} 這類幣建議記在「投資 → 新增持倉」（才有成本與報酬率）；帳戶的「期初餘額」只放穩定幣或現金。同一筆不要兩邊都記。</div>`;
  return "";
}
function editorHint(kind, data, record) {
  let text = "";
  if (kind === "account" && INVESTMENT_ACCOUNT_TYPES.includes(data.類型)) text = `<strong>${esc(data.類型)}帳戶怎麼填</strong>　「期初餘額」只填帳戶裡<strong>還沒投資的現金</strong>${data.類型 === "加密貨幣" ? "（或穩定幣）" : ""}，沒有就填 0。已經買的標的請到「投資 → 新增持倉」填數量與平均成本，不要記成支出，也不要算進期初餘額。`;
  else if (kind === "account" && data.類型 === "信用卡") text = "<strong>信用卡怎麼填</strong>　「期初餘額」填目前未繳總額並加負號，例如 -12000；沒有欠款填 0。";
  else if (kind === "account" && data.類型 === "保險") text = "<strong>保險怎麼填</strong>　純保障型選「不計入（純保障）」；有解約金的保單選「計入資產」並填目前保單價值（不是已繳保費）。";
  else if (kind === "holding" && !record) text = "<strong>已經持有的股票／加密貨幣</strong>　直接在這裡填目前的「數量」與「平均成本」（每單位買進均價），不用補記買入交易，也不會算成支出。之後再加碼才用「記一筆 → 投資買入」。";
  return (kind === "holding" ? holdingPicker(data) : "") + duplicateHint(kind, data) + (text ? `<div class="receipt-tools">${text}</div>` : "");
}
function numberAttrs(f) {
  if (f.type !== "number") return "";
  return `step="${f.step ?? "any"}"${f.min !== undefined ? ` min="${f.min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""}${f.step ? ' inputmode="numeric"' : ""}`;
}
function holdingPlatform(row) {
  const id = asArray(row?.p?.帳戶)[0]; const account = id ? state.accounts.find((a) => a.id === id) : null;
  return account?.p?.名稱 || "";
}
function relationLabel(source, row, rows) {
  if (source !== "holdings") return row.p?.名稱 || row.p?.["店家／項目"] || row.id;
  const platform = holdingPlatform(row); const base = row.p?.名稱 || row.id;
  let label = platform ? `${base} · ${platform}` : `${base} · （未指定平台）`;
  if (rows.some((x) => x !== row && (x.p?.名稱 || x.id) === base && holdingPlatform(x) === platform)) label += `（${row.p?.代號 || row.id.slice(-4)}）`;
  return label;
}
function renderField(f, value) {
  const className = `${f.wide ? "wide " : ""}${f.type === "checkbox" ? "check" : ""}`;
  if (f.type === "select") {
    const choices = typeof f.choices === "function" ? f.choices() : f.choices; const current = String(value ?? "");
    // 既有資料若不在選單內（例如舊的手填國家），保留為選項，避免編輯時被清空
    const all = current && !choices.includes(current) ? [current, ...choices] : choices;
    const manage = f.manage ? `<option value="__manage__">＋ 新增／刪除選項…</option>` : "";
    return `<label class="${className}">${esc(f.label)}<select name="${esc(f.name)}" data-prev="${esc(current)}" ${f.manage ? `data-manage="${f.manage}"` : ""}><option value="">請選擇</option>${all.map((choice) => `<option ${current === choice ? "selected" : ""}>${esc(choice)}</option>`).join("")}${manage}</select></label>`;
  }
  if (f.type === "relation") {
    const all = state[f.source] || []; const selected = asArray(value)[0] || "";
    // 帳戶欄位只列「這個情境需要的種類」，並依種類分組；已選的永遠保留，也能切到「顯示全部帳戶」
    const kinds = f.source === "accounts" && typeof f.kinds === "function" && !state.editor?.showAllAccounts ? f.kinds(state.editor?.currentData || {}, state.editor?.transactionType) : null;
    const rows = kinds ? all.filter((row) => kinds.includes(row.p?.類型) || row.id === selected) : all;
    const option = (row) => `<option value="${esc(row.id)}" ${selected === row.id ? "selected" : ""}>${esc(relationLabel(f.source, row, rows))}</option>`;
    let body;
    if (f.source === "accounts") {
      const groups = new Map(); for (const row of rows) { const t = row.p?.類型 || "其他"; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(row); }
      body = [...groups.entries()].map(([type, list]) => `<optgroup label="${esc(type)}">${list.map(option).join("")}</optgroup>`).join("");
    } else body = rows.map(option).join("");
    const more = kinds && rows.length < all.length ? '<option value="__all__">… 顯示全部帳戶</option>' : "";
    return `<label class="${className}">${esc(f.label)}<select name="${esc(f.name)}"><option value="">無</option>${body}${more}</select></label>`;
  }
  if (f.type === "checkbox") return `<label class="${className}"><input type="checkbox" name="${esc(f.name)}" ${value ?? f.default ? "checked" : ""}>${esc(f.label)}</label>`;
  if (f.type === "textarea") return `<label class="${className}">${esc(f.label)}<textarea name="${esc(f.name)}" rows="3">${esc(value || "")}</textarea></label>`;
  const fallback = f.type === "date" ? todayISO() : "";
  return `<label class="${className}">${esc(f.label)}<input name="${esc(f.name)}" type="${f.type}" ${numberAttrs(f)} value="${esc(value ?? fallback)}"></label>`;
}
function collectEditorData() {
  const form = $("#editor-form"); const data = {};
  for (const input of $$('[name]', form)) {
    if (input.type === "checkbox") data[input.name] = input.checked;
    else if (input.type === "number") data[input.name] = input.value === "" ? null : number(input.value);
    else if (RELATION_FIELDS.has(input.name)) data[input.name] = input.value && input.value !== "__all__" ? [input.value] : [];
    else data[input.name] = input.value;
  }
  return data;
}
async function saveEditor() {
  const { kind, record } = state.editor; const data = collectEditorData();
  for (const [name, max] of [["結帳日", 31], ["繳款日", 31], ["扣款日", 31], ["扣款月份", 12]]) {
    if (data[name] !== undefined && data[name] !== null && !(Number.isInteger(data[name]) && data[name] >= 1 && data[name] <= max)) { data[name] = null; toast(`${name}要填 1～${max} 的整數，已清除請重填`); }
  } const table = ({ account: "accounts", holding: "holdings", recurring: "recurring", transaction: "transactions" })[kind];
  if (kind === "transaction") {
    const account = state.accounts.find((x) => hasRelation(data.帳戶, x.id));
    let twd = toTWD(data.原幣金額 || number(data.成交數量) * number(data.成交單價), data.幣別 || "TWD");
    if (data.實扣金額) twd = toTWD(data.實扣金額, account?.p?.幣別 || "TWD");
    if (data.收支 === "支出" && account?.p?.類型 === "信用卡" && data.幣別 !== account.p.幣別 && !data.實扣金額) { twd *= 1.015; data.狀態 = "預估"; }
    data.台幣金額 = Math.round(twd * 100) / 100;
    if (data.收支.startsWith("投資") && data.持倉?.length) await updateHoldingFromTrade(data, record);
  }
  const { receiptImage, receiptRemoved } = state.editor;
  const saved = await saveRecord(table, data, record);
  if (kind === "transaction" && (receiptImage || receiptRemoved)) {
    const key = `receipt-${syncIdFor(saved)}`;
    try { if (receiptImage) await putOne("meta", { id: key, image: receiptImage, saved_at: nowISO() }); else await deleteOne("meta", key); }
    catch (error) { toast("收據照片無法存到這台裝置（空間不足？），交易本身已儲存"); }
    await loadState(); render();
  }
  toast("已先存到本機");
}
async function updateHoldingFromTrade(data, previousTransaction) {
  const holding = state.holdings.find((x) => hasRelation(data.持倉, x.id)); if (!holding) return;
  const oldQty = number(holding.p?.數量); const oldAvg = number(holding.p?.平均成本); const qty = number(data.成交數量); const price = number(data.成交單價);
  let nextQty = oldQty; let nextAvg = oldAvg;
  if (previousTransaction?.p?.收支?.startsWith("投資") && hasRelation(previousTransaction.p.持倉, holding.id)) {
    const prevQty = number(previousTransaction.p.成交數量); nextQty += previousTransaction.p.收支 === "投資買入" ? -prevQty : prevQty;
  }
  if (data.收支 === "投資買入") { nextAvg = nextQty + qty > 0 ? ((nextQty * oldAvg) + (qty * price)) / (nextQty + qty) : price; nextQty += qty; }
  else nextQty = Math.max(0, nextQty - qty);
  await saveRecord("holdings", { 數量: nextQty, 平均成本: nextAvg }, holding);
}

function readFileAsDataURL(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
async function resizeReceipt(file) {
  const src = await readFileAsDataURL(file); const image = new Image();
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = src; });
  const scale = Math.min(1, 1280 / Math.max(image.width, image.height)); const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", .82); return { dataUrl, mime_type: "image/jpeg", image_base64: dataUrl.split(",")[1] };
}
async function analyzeReceipt(file) {
  if (!file || !state.editor || state.editor.kind !== "transaction") return;
  const editor = state.editor;
  try {
    const { dataUrl, ...image } = await resizeReceipt(file);
    // 先把照片顯示在表單下方，辨識成功與否都能對照核對
    editor.draft = { ...editor.draft, ...collectEditorData() }; editor.receiptImage = dataUrl; editor.receiptRemoved = false;
    if (!state.settings.token) { editor.receiptStatus = "照片已附在下方。AI 辨識需要先在「更多 → 設定」輸入連線碼，目前請對照照片手動填寫。"; renderEditorFields(); return; }
    if (!navigator.onLine) { editor.receiptStatus = "照片已附在下方。目前離線無法辨識，請對照照片手動填寫。"; renderEditorFields(); return; }
    editor.receiptStatus = "辨識中…通常 10～40 秒，照片已顯示在下方。"; renderEditorFields();
    const startedAt = Date.now(); const controller = new AbortController();
    const timer = setInterval(() => { const el = $("#receipt-status-text"); if (el) el.textContent = `辨識中…已等 ${Math.round((Date.now() - startedAt) / 1000)} 秒（通常 10～40 秒），照片已顯示在下方。`; }, 1000);
    const abortTimer = setTimeout(() => controller.abort(), 120000);
    let response;
    try { response = await fetch(endpoint("piggy-receipt"), { method: "POST", headers: apiHeaders(), body: JSON.stringify({ ...image, currencies: currencyCodes() }), signal: controller.signal }); }
    catch (error) { throw new Error(error?.name === "AbortError" ? "等太久沒有回應（超過 2 分鐘），請再按一次辨識" : error.message); }
    finally { clearInterval(timer); clearTimeout(abortTimer); }
    if (!response.ok) throw new Error(`辨識服務回應 ${response.status}`); const payload = await response.json().catch(() => ({})); if (!payload.ok) throw new Error(payload.error || "辨識失敗");
    const found = payload.data || payload.result || {}; const allowed = ["店家／項目", "日期", "原幣金額", "幣別", "分類", "備註", "狀態"];
    const current = collectEditorData(); state.editor.draft = { ...state.editor.draft, ...current, ...Object.fromEntries(allowed.filter((key) => found[key] !== undefined && found[key] !== null).map((key) => [key, found[key]])) };
    const foundCurrency = String(found["幣別"] || "").trim().toUpperCase();
    let addedCurrency = "";
    if (/^[A-Z]{3}$/.test(foundCurrency) && !currencyCodes().includes(foundCurrency)) { await addCurrency(foundCurrency, "fiat"); addedCurrency = foundCurrency; }
    if (state.editor !== editor) return;
    state.editor.receiptStatus = `${addedCurrency ? `已自動新增幣別 ${addedCurrency}，匯率稍後自動更新。` : ""}辨識完成${found.confidence ? `（信心 ${Math.round(number(found.confidence) * 100)}%）` : ""}，請對照下方收據照片核對後再儲存。`; renderEditorFields();
  } catch (error) { if (state.editor !== editor) return; editor.draft = { ...editor.draft, ...collectEditorData() }; editor.receiptStatus = `辨識失敗：${error.message}${editor.receiptImage ? "；可對照下方照片手動填寫。" : ""}`; renderEditorFields(); }
  finally { $("#receipt-input").value = ""; $("#receipt-gallery-input").value = ""; }
}

function openCardDialog(card) {
  const rows = state.transactions.filter((row) => hasRelation(row.p?.帳戶, card.id) && row.p?.收支 === "支出").sort((a, b) => String(b.p?.日期 || "").localeCompare(String(a.p?.日期 || ""))).slice(0, 60);
  $("#card-title").textContent = `${card.p?.名稱 || "信用卡"}對帳`;
  $("#card-content").innerHTML = `<p>銀行入帳後，直接改原交易的實扣金額；系統不會新增第二筆支出。</p>${rows.length ? rows.map((row) => `<div class="reconcile-row"><div><strong>${esc(row.p?.["店家／項目"] || "信用卡消費")}</strong><div class="item-meta">${esc(row.p?.日期 || "")} · ${esc(row.p?.狀態 || "預估")} · 原幣 ${nativeMoney(row.p?.原幣金額, row.p?.幣別 || "TWD")}</div></div><label>實扣金額<input data-card-actual="${esc(row.id)}" type="number" step="any" value="${esc(row.p?.實扣金額 ?? "")}" placeholder="銀行入帳金額"></label><button type="button" data-reconcile-save="${esc(row.id)}">確認入帳</button></div>`).join("") : '<div class="empty-state">目前沒有這張卡的消費</div>'}`;
  $("#card-dialog").showModal();
}
async function reconcileTransaction(id) {
  const row = state.transactions.find((item) => item.id === id); const input = $(`[data-card-actual="${CSS.escape(id)}"]`); if (!row || !input || input.value === "") return toast("請填銀行實際入帳金額");
  const card = state.accounts.find((item) => hasRelation(row.p?.帳戶, item.id)); const actual = number(input.value);
  await saveRecord("transactions", { 實扣金額: actual, 台幣金額: toTWD(actual, card?.p?.幣別 || "TWD"), 狀態: "已入帳" }, row);
  openCardDialog(card); toast("已更新原交易，不會重複計算");
}
function openCardPayment(card) {
  const amount = Math.max(0, Math.abs(accountBalance(card)));
  openEditor("transaction", null, { 收支: "轉帳", "店家／項目": `繳${card.p?.名稱 || "信用卡"}卡費`, 日期: todayISO(), 原幣金額: amount, 幣別: card.p?.幣別 || "TWD", 轉入帳戶: [card.id], 狀態: "已繳款", 備註: "信用卡繳款是轉帳，不重複列支出" });
}

function addPeriod(dateText, period, anchorDay = 0) {
  if (period === "週") { const d = new Date(`${dateText}T12:00:00`); d.setDate(d.getDate() + 7); return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }); }
  const [y, m, d0] = String(dateText).split("-").map(Number);
  const total = y * 12 + (m - 1) + (period === "季" ? 3 : period === "年" ? 12 : 1);
  const ny = Math.floor(total / 12); const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay > 0 ? anchorDay : d0, lastDay);
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
async function generateRecurringTransactions() {
  const today = todayISO(); let created = 0;
  for (const rule of state.recurring.filter((row) => row.p?.啟用 !== false && row.p?.下次扣款 && row.p.下次扣款 <= today)) {
    let due = rule.p.下次扣款; let guard = 0; const anchor = number(rule.p?.扣款日) || Number(String(rule.p.下次扣款).slice(8, 10));
    while (due <= today && guard++ < 24) {
      const syncId = `recurring-${syncIdFor(rule)}-${due}`; const exists = state.transactions.some((row) => row.p?.同步編號 === syncId || (row.p?.日期 === due && hasRelation(row.p?.固定支出, rule.id)));
      if (!exists) {
        const holding = state.holdings.find((row) => hasRelation(rule.p?.對應持倉, row.id)); const target = asArray(holding?.p?.帳戶);
        const isAsset = rule.p?.性質 === "轉入資產" && target.length;
        await saveRecord("transactions", { 同步編號: syncId, 收支: isAsset ? "轉帳" : "支出", "店家／項目": rule.p?.名稱 || "固定支出", 日期: due, 原幣金額: number(rule.p?.金額), 幣別: rule.p?.幣別 || "TWD", 帳戶: asArray(rule.p?.扣款帳戶), 轉入帳戶: isAsset ? target : [], 固定支出: [rule.id], 分類: rule.p?.群組 || (isAsset ? "投資" : "其他"), 狀態: "已入帳", 備註: `${rule.p?.週期 || "月"}期自動產生` }); created += 1;
      }
      due = addPeriod(due, rule.p?.週期 || "月", anchor);
    }
    if (due !== rule.p.下次扣款) await saveRecord("recurring", { 下次扣款: due }, rule);
  }
  if (created) toast(`已自動產生 ${created} 筆到期固定支出`);
}

async function saveTodaySnapshot() {
  const t = totals(); const date = todayISO(); const existing = state.snapshots.find((row) => (row.p?.日期 || row.p?.快照日) === date);
  const values = { 日期: date, 快照日: date, 淨資產TWD: Math.round(t.net), 投資TWD: Math.round(t.investments), USD匯率: roundedNumber(rate("USD"), 6), THB匯率: roundedNumber(rate("THB"), 6), JPY匯率: roundedNumber(rate("JPY"), 6), 抓價狀態: "App 本機快照" };
  await putOne("snapshots", { id: existing?.id || `snapshot-${date}`, edited: existing?.edited || null, p: values });
}
function cryptoSymbol(text) {
  const raw = String(text || "").trim();
  if (/^cg:/i.test(raw)) return `cg:${raw.slice(3).trim().toLowerCase()}`;
  const lower = raw.toLowerCase(); if (Object.values(COINGECKO_IDS).includes(lower)) return `cg:${lower}`;
  return raw.toUpperCase().split(/[-\/_\s]/)[0];
}
async function coingeckoIds(symbols) {
  const ids = {}; const cache = { ...(state.settings.cgIds || {}) }; let changed = false;
  for (const symbol of symbols) {
    if (String(symbol).startsWith("cg:")) { ids[symbol] = symbol.slice(3); continue; }
    if (COINGECKO_IDS[symbol] || cache[symbol]) { ids[symbol] = COINGECKO_IDS[symbol] || cache[symbol]; continue; }
    try {
      const found = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`).then((response) => response.ok ? response.json() : null);
      const coin = (found?.coins || []).find((item) => String(item.symbol || "").toUpperCase() === symbol);
      if (coin?.id) { ids[symbol] = cache[symbol] = coin.id; changed = true; }
    } catch (error) { /* 找不到就維持手動價格 */ }
  }
  if (changed) { state.settings = { ...state.settings, cgIds: cache }; await putOne("meta", state.settings); }
  return ids;
}
// 一次批次向 CoinGecko 取得所有加密貨幣（幣別 + 持倉）的價格
async function fetchCryptoPrices(symbols) {
  if (!symbols.length) return {};
  const ids = await coingeckoIds(symbols); const wanted = [...new Set(Object.values(ids))]; if (!wanted.length) return {};
  const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${wanted.join(",")}&vs_currencies=twd,usd,thb,jpy&include_last_updated_at=true`);
  if (!response.ok) throw new Error(`CoinGecko 回應 ${response.status}`);
  const prices = await response.json();
  return Object.fromEntries(Object.entries(ids).filter(([, id]) => prices[id]).map(([symbol, id]) => [symbol, prices[id]]));
}
async function refreshPrices() {
  if (!navigator.onLine) return toast("目前離線，保留上次匯率與價格");
  if (state.refreshingPrices) return;
  state.refreshingPrices = true;
  const problems = [];
  try {
    toast("正在更新匯率與報價…");
    const list = currencyList(); const next = {};
    try {
      const fx = await fetch("https://open.er-api.com/v6/latest/TWD").then((response) => { if (!response.ok) throw new Error("匯率服務暫時無法使用"); return response.json(); });
      for (const item of list) if (item.kind === "fiat" && item.code !== "TWD" && number(fx?.rates?.[item.code]) > 0) next[`rate${item.code}`] = roundedNumber(1 / number(fx.rates[item.code]), 6);
      if (fx?.rates) next.fxUpdatedAt = fx.time_last_update_utc || nowISO();
    } catch (error) { problems.push(error.message); }
    const cryptoHoldings = state.holdings.filter((row) => row.p?.市場 === "加密貨幣" && row.p?.代號);
    let crypto = {};
    try {
      crypto = await fetchCryptoPrices([...new Set([...list.filter((item) => item.kind === "crypto").map((item) => item.code), ...cryptoHoldings.map((row) => cryptoSymbol(row.p.代號))])]);
      for (const item of list) if (item.kind === "crypto" && number(crypto[item.code]?.twd) > 0) next[`rate${item.code}`] = roundedNumber(crypto[item.code].twd, 8);
    } catch (error) { problems.push(`加密貨幣報價：${error.message}`); }
    if (Object.keys(next).length) { state.settings = { ...state.settings, ...next }; await putOne("meta", state.settings); }
    const quoted = new Set();
    if (state.settings.token && state.holdings.length) {
      try {
        const response = await fetch(endpoint("piggy-prices"), { method: "POST", headers: apiHeaders(), body: JSON.stringify({ holdings: state.holdings.map((row) => ({ id: row.id, name: row.p?.名稱, symbol: row.p?.代號, market: row.p?.市場, currency: row.p?.計價幣別, last_price: row.p?.最新價 })) }) });
        if (response.ok) { const payload = await response.json().catch(() => ({})); for (const quote of payload.quotes || []) { const holding = state.holdings.find((row) => row.id === quote.id); if (holding && quote.price) { await saveRecord("holdings", { 最新價: roundedNumber(quote.price, 8), 價格更新時間: quote.updated_at || nowISO(), 報價來源: quote.source || "自動報價" }, holding); quoted.add(quote.id); } } }
        else problems.push(`報價服務回應 ${response.status}`);
      } catch (error) { problems.push(`報價服務：${error.message}`); }
    }
    // n8n 沒查到的台股（例如上櫃股票），改用每日更新的台股資料檔
    try {
      const twList = await loadTwStocks();
      for (const row of state.holdings.filter((x) => x.p?.市場 === "台股" && x.p?.代號 && !quoted.has(x.id))) {
        const hit = twStockPrice(twList, row.p.代號);
        if (hit?.price) { await saveRecord("holdings", { 最新價: hit.price, 價格更新時間: nowISO(), 報價來源: hit.board === "櫃" ? "櫃買中心" : "證交所" }, row); quoted.add(row.id); }
      }
    } catch (error) { problems.push(`台股資料檔：${error.message}`); }
    // n8n 沒回報價的加密貨幣持倉，直接用 CoinGecko 的價格換算成持倉的計價幣別
    for (const row of cryptoHoldings) {
      if (quoted.has(row.id)) continue;
      const price = crypto[cryptoSymbol(row.p.代號)]; if (!price) continue;
      const currency = row.p?.計價幣別 || "TWD"; const direct = number(price[currency.toLowerCase()]);
      const value = direct > 0 ? direct : rate(currency) ? number(price.twd) / rate(currency) : 0;
      const holding = state.holdings.find((item) => item.id === row.id);
      if (holding && value > 0) await saveRecord("holdings", { 最新價: roundedNumber(value, 8), 價格更新時間: price.last_updated_at ? new Date(price.last_updated_at * 1000).toISOString() : nowISO(), 報價來源: "CoinGecko" }, holding);
    }
    await loadState(); await saveTodaySnapshot(); await loadState(); render(); renderSettings(true);
    toast(problems.length ? `部分報價未更新：${problems[0]}` : "匯率與可用報價已更新");
  } catch (error) { toast(`報價更新暫停：${error.message}`); }
  finally { state.refreshingPrices = false; }
}

function openWizard() { state.wizardStep = 0; state.wizardDate = state.accounts.find((a) => a.p?.開帳日)?.p?.開帳日 || todayISO(); renderWizard(); $("#wizard-dialog").showModal(); }
function renderWizard() {
  const steps = 4; $("#wizard-progress").textContent = `${state.wizardStep + 1} / ${steps}`; $("#wizard-prev").disabled = state.wizardStep === 0; $("#wizard-next").textContent = state.wizardStep === 3 ? "完成" : "下一步";
  const el = $("#wizard-content");
  if (state.wizardStep === 0) el.innerHTML = `<div class="wizard-step"><h3>選擇開帳日</h3><p>這一天以前的交易不用補；帳戶從期初餘額開始算。</p><label>開帳日<input id="wizard-date" type="date" value="${esc(state.wizardDate)}"></label></div>`;
  else if (state.wizardStep === 1) el.innerHTML = `<div class="wizard-step"><h3>逐一確認帳戶</h3><p>信用卡填目前未繳總額並加負號；保險填解約金。</p><div class="wizard-rows">${state.accounts.map((row) => `<div class="wizard-row"><div><strong>${esc(row.p?.名稱 || "未命名")}</strong><small>${esc(row.p?.類型 || "帳戶")} · ${esc(row.p?.幣別 || "TWD")}</small></div><input data-wizard-account="${esc(row.id)}" type="number" step="any" value="${esc(row.p?.期初餘額 ?? (row.p?.類型 === "信用卡" ? 0 : ""))}" placeholder="期初餘額"></div>`).join("")}</div></div>`;
  else if (state.wizardStep === 2) el.innerHTML = `<div class="wizard-step"><h3>填寫持倉數量與成本</h3><div class="wizard-rows">${state.holdings.map((row) => `<div class="wizard-row"><div><strong>${esc(row.p?.名稱 || "未命名")}</strong><small>${esc([row.p?.代號 || row.p?.市場 || "", holdingPlatform(row)].filter(Boolean).join(" · "))}</small></div><div><input data-wizard-holding-qty="${esc(row.id)}" type="number" step="any" value="${esc(row.p?.數量 ?? "")}" placeholder="數量"><input data-wizard-holding-avg="${esc(row.id)}" type="number" step="any" value="${esc(row.p?.平均成本 ?? "")}" placeholder="平均成本"></div></div>`).join("") || "目前沒有持倉，可稍後新增"}</div></div>`;
  else el.innerHTML = `<div class="wizard-step empty-state"><div><div style="font-size:4rem">🐷✨</div><h3>準備完成</h3><p>按「完成」後，資料會先安全存到本機；有連線碼時再自動同步。</p></div></div>`;
}
async function wizardNext() {
  if (state.wizardStep === 0) state.wizardDate = $("#wizard-date").value || todayISO();
  else if (state.wizardStep === 1) {
    for (const input of $$('[data-wizard-account]')) { const row = state.accounts.find((x) => x.id === input.dataset.wizardAccount); if (row) await saveRecord("accounts", { 開帳日: state.wizardDate, 期初餘額: input.value === "" ? null : number(input.value) }, row); }
  } else if (state.wizardStep === 2) {
    for (const input of $$('[data-wizard-holding-qty]')) { const row = state.holdings.find((x) => x.id === input.dataset.wizardHoldingQty); const avg = row ? $(`[data-wizard-holding-avg="${CSS.escape(row.id)}"]`) : null; if (row) await saveRecord("holdings", { 數量: input.value === "" ? null : number(input.value), 平均成本: avg?.value === "" ? null : number(avg?.value) }, row); }
  }
  if (state.wizardStep === 3) { $("#wizard-dialog").close(); toast("開帳資料已儲存"); render(); return; }
  state.wizardStep += 1; renderWizard();
}

function findRecord(kind, id) { return state[({ account: "accounts", holding: "holdings", recurring: "recurring", transaction: "transactions" })[kind]].find((x) => x.id === id); }
function bindEvents() {
  document.addEventListener("click", async (event) => {
    const nav = event.target.closest("[data-nav]"); if (nav) return switchView(nav.dataset.nav);
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "transaction") openEditor("transaction");
    else if (action === "account") openEditor("account");
    else if (action === "holding") openEditor("holding");
    else if (action === "recurring") openEditor("recurring");
    else if (action === "wizard") openWizard();
    else if (action === "sync") await synchronize(false);
    else if (action === "full-sync") await synchronize(true);
    else if (action === "retry") await pushOutbox();
    else if (action === "prices") await refreshPrices();
    else if (action === "add-currency") await addCurrency();
    else if (action === "remove-currency") await removeCurrency(event.target.closest("[data-code]").dataset.code);
    else if (action === "remove-receipt" && state.editor) { state.editor.draft = { ...state.editor.draft, ...collectEditorData() }; state.editor.receiptImage = null; state.editor.receiptRemoved = true; state.editor.receiptStatus = ""; renderEditorFields(); }
    const cardAction = event.target.closest("[data-card-action]");
    if (cardAction) { const card = state.accounts.find((row) => row.id === cardAction.dataset.id); if (cardAction.dataset.cardAction === "reconcile") openCardDialog(card); else openCardPayment(card); return; }
    const reconcile = event.target.closest("[data-reconcile-save]"); if (reconcile) { await reconcileTransaction(reconcile.dataset.reconcileSave); return; }
    const edit = event.target.closest("[data-edit]"); if (edit) openEditor(edit.dataset.edit, findRecord(edit.dataset.edit, edit.dataset.id));
    const type = event.target.closest("[data-transaction-type]")?.dataset.transactionType; if (type && state.editor) { state.editor.draft = { ...state.editor.draft, ...collectEditorData(), 收支: type }; state.editor.transactionType = type; renderEditorFields(); }
  });
  // 帳戶類型改變時重畫表單：信用卡／保險欄位只在選到該類型時出現
  $("#editor-fields").addEventListener("change", (event) => {
    const sel = event.target;
    if (sel.value === "__all__") { state.editor.showAllAccounts = true; state.editor.draft = { ...state.editor.draft, ...collectEditorData() }; renderEditorFields(); return; }
    if (state.editor?.kind === "transaction" && sel.name === "持倉") { /* 持倉選項不分組 */ }
    if (sel.value === "__manage__") { sel.value = sel.dataset.prev || ""; openOptionsDialog(sel.dataset.manage); return; }
    if (sel.dataset?.prev !== undefined) sel.dataset.prev = sel.value;
    if (state.editor?.kind === "holding" && sel.name === "市場") { state.editor.draft = { ...state.editor.draft, ...collectEditorData() }; renderEditorFields(); return; }
    if (state.editor?.kind === "account" && sel.name === "幣別") { state.editor.draft = { ...state.editor.draft, ...collectEditorData() }; renderEditorFields(); return; }
    if (state.editor?.kind !== "account" || event.target.name !== "類型") return;
    state.editor.draft = { ...state.editor.draft, ...collectEditorData() }; renderEditorFields();
  });
  $("#editor-fields").addEventListener("input", (event) => {
    if (event.target.id === "stock-search") { clearTimeout(coinSearchTimer); const value = event.target.value; coinSearchTimer = setTimeout(() => void searchTwStocks(value), 250); return; }
    if (event.target.id !== "coin-search") return; clearTimeout(coinSearchTimer); const value = event.target.value; coinSearchTimer = setTimeout(() => void searchCoins(value), 400);
  });
  $("#editor-fields").addEventListener("click", (event) => {
    const coin = event.target.closest("[data-coin-id]"); if (coin) { pickCoin(coin); return; }
    const stock = event.target.closest("[data-stock-code]"); if (stock) { pickTwStock(stock); return; }
    if (event.target.closest('[data-action="verify-symbol"]')) void verifySymbol();
  });
  $("#options-dialog").addEventListener("click", (event) => {
    if (event.target.closest("[data-options-close]")) $("#options-dialog").close();
    if (event.target.closest("[data-options-add]")) void optionsAdd();
    const del = event.target.closest("[data-options-delete]"); if (del) void optionsDelete(del.dataset.optionsDelete);
  });
  $("#options-dialog").addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target.id === "options-new") { event.preventDefault(); void optionsAdd(); } });
  $("#new-currency-code").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void addCurrency(); } });
  $("#editor-dialog").addEventListener("close", async () => { if ($("#editor-dialog").returnValue === "save") await saveEditor(); });
  $("#delete-button").addEventListener("click", async () => {
    const { kind, record } = state.editor; if (!record) return; const isTrade = kind === "transaction" && String(record.p?.收支 || "").startsWith("投資"); if (!confirm(isTrade ? "確定刪除這筆投資買賣？刪除後持倉的數量會還原，帳戶的錢也會回到原來的樣子。離線時會先排入待送清單。" : "確定刪除這筆資料？離線時會先排入待送清單。")) return;
    await removeRecord(({ account: "accounts", holding: "holdings", recurring: "recurring", transaction: "transactions" })[kind], record); $("#editor-dialog").close(); toast("已刪除");
  });
  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const settings = { ...state.settings, id: "settings", baseUrl: String(form.get("baseUrl") || DEFAULT_SETTINGS.baseUrl).replace(/\/$/, ""), token: String(form.get("token") || ""), displayCurrency: form.get("displayCurrency") || "TWD", rateTWD: 1, ...Object.fromEntries(currencyCodes().filter((code) => code !== "TWD").map((code) => [`rate${code}`, roundedNumber(number(form.get(`rate${code}`)), 8)])) };
    await putOne("meta", settings); await loadState(); render(); renderSettings(true); toast("設定已儲存在這台裝置"); if (settings.token) void synchronize(false);
  });
  $("#wizard-prev").addEventListener("click", () => { if (state.wizardStep > 0) { state.wizardStep -= 1; renderWizard(); } });
  $("#wizard-next").addEventListener("click", wizardNext);
  $("#receipt-button").addEventListener("click", () => $("#receipt-input").click());
  $("#receipt-input").addEventListener("change", (event) => void analyzeReceipt(event.target.files?.[0]));
  $("#receipt-gallery-button").addEventListener("click", () => $("#receipt-gallery-input").click());
  $("#receipt-gallery-input").addEventListener("change", (event) => void analyzeReceipt(event.target.files?.[0]));
  window.addEventListener("online", () => { updateNetworkPill(); void pushOutbox(); });
  window.addEventListener("offline", updateNetworkPill);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void synchronize(false); });
}

async function init() {
  try {
    state.db = await openDatabase(); await loadState(); bindEvents(); render(); switchView("overview");
    await generateRecurringTransactions(); await saveTodaySnapshot(); await loadState(); render();
    const isNativeApp = Boolean(window.Capacitor?.isNativePlatform?.());
    document.documentElement.classList.toggle("is-native", isNativeApp);
    const AppPlugin = window.Capacitor?.Plugins?.App;
    if (isNativeApp && AppPlugin?.addListener) {
      let lastBack = 0;
      AppPlugin.addListener("backButton", () => {
        const dialogs = [...document.querySelectorAll("dialog[open]")];
        if (dialogs.length) { dialogs[dialogs.length - 1].close("cancel"); return; }
        if (state.view && state.view !== "overview") { switchView("overview"); return; }
        const now = Date.now();
        if (now - lastBack < 2000) { AppPlugin.exitApp(); return; }
        lastBack = now; toast("再滑一次返回才會離開小豬帳本");
      });
    }
    // 網頁版／PWA（手機觸控）：返回手勢跟 App 版一致——先關視窗、再回總覽、總覽連按兩次才離開。
    // Chrome 134+ 的 modal <dialog> 會自己處理返回手勢（closedby），這裡補舊瀏覽器與「回總覽」「離開確認」。
    if (!isNativeApp && window.matchMedia?.("(pointer: coarse)").matches) {
      let lastBack = 0; const guard = () => history.pushState({ piggyGuard: true }, "");
      history.replaceState({ piggyRoot: true }, ""); guard();
      window.addEventListener("popstate", () => {
        const dialogs = [...document.querySelectorAll("dialog[open]")];
        if (dialogs.length) { dialogs[dialogs.length - 1].close("cancel"); guard(); return; }
        if (state.view && state.view !== "overview") { switchView("overview"); guard(); return; }
        const now = Date.now();
        if (now - lastBack < 2000) { history.back(); return; }
        lastBack = now; toast("再滑一次返回才會離開小豬帳本"); guard();
      });
    }
    if (!isNativeApp && "serviceWorker" in navigator) {
      // GitHub Pages 預設快取 10 分鐘：用 updateViaCache:none 與 no-cache 讓新版立刻生效；有新版時自動重新載入（有視窗開著就先提示）
      const hadController = Boolean(navigator.serviceWorker.controller); let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController || reloaded) return;
        if (document.querySelector("dialog[open]")) { toast("已有新版本，關閉視窗後重新整理即可更新"); return; }
        reloaded = true; location.reload();
      });
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((registration) => registration.update()).catch(() => {});
    }
    if (navigator.onLine && state.settings.token) void synchronize(false);
    const fxAge = Date.now() - Date.parse(state.settings.fxUpdatedAt || "1970-01-01");
    if (navigator.onLine && fxAge > 12 * 3600 * 1000) void refreshPrices();
    setInterval(() => { if (!document.hidden) void synchronize(false); }, 5 * 60 * 1000);
  } catch (error) { console.error(error); document.body.innerHTML = `<main style="margin:2rem"><h1>小豬帳本暫時打不開</h1><p>${esc(error.message)}</p></main>`; }
}
document.addEventListener("DOMContentLoaded", init);
