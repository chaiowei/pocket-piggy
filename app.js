"use strict";

const APP_VERSION = "2.0.1-p3";
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
};

const state = {
  db: null,
  settings: { ...DEFAULT_SETTINGS },
  accounts: [], holdings: [], recurring: [], snapshots: [], transactions: [],
  outbox: [], failed: [], lastSync: null,
  view: "overview", editor: null, wizardStep: 0, wizardDate: todayISO(), syncing: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
function todayISO() { return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }); }
function nowISO() { return new Date().toISOString(); }
function asArray(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
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
  const [settings, lastSync, ...collections] = await Promise.all([
    getOne("meta", "settings"), getOne("meta", "lastSync"),
    ...TABLES.map(getAll), getAll("outbox"), getAll("failed"),
  ]);
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  state.lastSync = lastSync?.value || null;
  TABLES.forEach((table, index) => { state[table] = collections[index] || []; });
  state.outbox = collections[TABLES.length] || [];
  state.failed = collections[TABLES.length + 1] || [];
}

function rate(currency = "TWD") { return number(state.settings[`rate${currency}`]) || 1; }
function toTWD(amount, currency = "TWD") { return number(amount) * rate(currency); }
function fromTWD(amount, currency = state.settings.displayCurrency) { return number(amount) / rate(currency); }
function currencySymbol(currency) { return ({ TWD: "NT$", THB: "฿", USD: "US$", JPY: "¥" })[currency] || currency; }
function moneyTWD(twd, compact = false) {
  const currency = state.settings.displayCurrency || "TWD";
  const value = fromTWD(twd, currency);
  return `${currencySymbol(currency)}${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: compact ? 0 : currency === "TWD" ? 0 : 2 }).format(value)}`;
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
    const amount = nativeAmount(row);
    const fee = number(t.手續費);
    if (source) {
      if (t.收支 === "收入") balance += amount;
      else if (t.收支 === "支出" || t.收支 === "轉帳") balance -= amount;
      else if (t.收支 === "投資買入") balance -= amount + fee;
      else if (t.收支 === "投資賣出") balance += amount - fee;
      else if (t.收支 === "估值調整") balance += amount;
    }
    if (target && t.收支 === "轉帳") {
      const targetAmount = t.實扣金額 ? number(t.實扣金額) : toTWD(t.原幣金額, t.幣別) / rate(p.幣別 || "TWD");
      balance += targetAmount;
    }
  }
  return balance;
}
function accountTWD(account) {
  const p = account.p || {};
  if (p.類型 === "保險") return p.計入資產 === "是" || p.計入資產 === true ? toTWD(p.保單價值, p.幣別) : 0;
  return toTWD(accountBalance(account), p.幣別 || "TWD");
}
function holdingTWD(holding) { const p = holding.p || {}; return toTWD(number(p.數量) * number(p.最新價 ?? p.平均成本), p.計價幣別 || "TWD"); }
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
async function removeRecord(table, record) {
  const syncId = syncIdFor(record);
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
  $("#open-warning").classList.toggle("hidden", !state.accounts.length || !incomplete);
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
  return `<div class="list-item" data-edit="transaction" data-id="${esc(row.id)}"><div class="item-main"><span class="item-icon">${p.收支 === "收入" ? "💰" : p.收支?.startsWith("投資") ? "📈" : p.收支 === "轉帳" ? "↔️" : "🧾"}</span><div><div class="item-title">${esc(p["店家／項目"] || p.收支 || "交易")}${row.pending ? '<span class="pending-badge">待送</span>' : ""}</div><div class="item-meta">${esc(p.日期 || "")} · ${esc(p.分類 || p.幣別 || "")}</div></div></div><div class="amount ${p.收支 === "支出" ? "expense" : ""}">${sign}${moneyTWD(transactionTWD(row), true)}</div></div>`;
}
function renderAccounts() {
  const groups = new Map(); state.accounts.filter((x) => x.p?.啟用 !== false).forEach((row) => { const type = row.p?.類型 || "其他"; if (!groups.has(type)) groups.set(type, []); groups.get(type).push(row); });
  const el = $("#account-groups"); el.classList.toggle("empty-state", !state.accounts.length);
  el.innerHTML = groups.size ? [...groups.entries()].map(([type, rows]) => `<section><h2 class="group-title">${esc(type)}</h2><div class="group-card">${rows.map((row) => `<div class="account-row" data-edit="account" data-id="${esc(row.id)}"><div class="item-main"><span class="item-icon">${iconFor(type)}</span><div><div class="account-name">${esc(row.p?.名稱 || "未命名")}${row.pending ? '<span class="pending-badge">待送</span>' : ""}</div><div class="item-meta">${esc(row.p?.幣別 || "TWD")}${type === "信用卡" ? ` · 結帳 ${esc(row.p?.結帳日 || "－")} 日／繳款 ${esc(row.p?.繳款日 || "－")} 日` : ""}</div></div></div><div class="account-balance">${moneyTWD(accountTWD(row))}<div class="item-meta">${currencySymbol(row.p?.幣別 || "TWD")}${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 }).format(accountBalance(row))}</div>${type === "信用卡" ? `<div class="account-actions"><button type="button" class="secondary" data-card-action="reconcile" data-id="${esc(row.id)}">對帳</button><button type="button" data-card-action="pay" data-id="${esc(row.id)}">繳卡費</button></div>` : ""}</div></div>`).join("")}</div></section>`).join("") : "尚無帳戶";
}
function renderHoldings() {
  const total = state.holdings.reduce((sum, row) => sum + holdingTWD(row), 0); $("#holding-total").textContent = `總現值 ${moneyTWD(total)}`;
  const el = $("#holding-list"); el.classList.toggle("empty-state", !state.holdings.length);
  el.innerHTML = state.holdings.length ? state.holdings.map((row) => `<article class="holding-card" data-edit="holding" data-id="${esc(row.id)}"><header><div><h3>${esc(row.p?.名稱 || "未命名")}</h3><span class="item-meta">${esc(row.p?.代號 || row.p?.市場 || "")}</span></div><span>${row.pending ? '<span class="pending-badge">待送</span>' : "📈"}</span></header><div class="price">${moneyTWD(holdingTWD(row))}</div><div class="item-meta">${number(row.p?.數量).toLocaleString()} × ${currencySymbol(row.p?.計價幣別 || "TWD")}${number(row.p?.最新價 ?? row.p?.平均成本).toLocaleString()}</div><div class="price-meta"><span class="${row.p?.報價來源 ? "price-ok" : "price-warn"}">${esc(row.p?.報價來源 || "手動價格")}</span><span class="item-meta">${esc(String(row.p?.價格更新時間 || "尚未更新").slice(0, 16).replace("T", " "))}</span></div></article>`).join("") : "尚無持倉";
}
function monthlyEquivalent(p) { const amount = toTWD(p.金額, p.幣別); return p.週期 === "年" ? amount / 12 : p.週期 === "季" ? amount / 3 : p.週期 === "週" ? amount * 52 / 12 : amount; }
function renderRecurring() {
  const active = state.recurring.filter((x) => x.p?.啟用 !== false); $("#monthly-recurring").textContent = moneyTWD(active.filter((x) => x.p?.性質 !== "轉入資產").reduce((sum, x) => sum + monthlyEquivalent(x.p || {}), 0));
  const el = $("#recurring-list"); el.classList.toggle("empty-state", !active.length);
  el.innerHTML = active.length ? active.map((row) => `<div class="list-item" data-edit="recurring" data-id="${esc(row.id)}"><div class="item-main"><span class="item-icon">📅</span><div><div class="item-title">${esc(row.p?.名稱 || "固定支出")}${row.pending ? '<span class="pending-badge">待送</span>' : ""}</div><div class="item-meta">${esc(row.p?.週期 || "月")} · ${esc(row.p?.性質 || "支出")}</div></div></div><strong>${currencySymbol(row.p?.幣別 || "TWD")}${number(row.p?.金額).toLocaleString()}</strong></div>`).join("") : "尚無固定支出";
}
function renderSettings() {
  const form = $("#settings-form"); if (!form) return;
  for (const [key, value] of Object.entries(state.settings)) if (form.elements[key]) form.elements[key].value = value ?? "";
}
function renderQueue() {
  const rows = [...state.outbox.map((x) => ({ ...x, failed: false })), ...state.failed.map((x) => ({ ...x, failed: true }))];
  const el = $("#queue-list"); el.classList.toggle("empty-state", !rows.length);
  el.innerHTML = rows.length ? rows.map((row) => `<div class="list-item"><div><div class="item-title">${esc(({ accounts: "帳戶", holdings: "持倉", recurring: "固定支出", transactions: "交易" })[row.table] || row.table)}${row.failed ? '<span class="error-badge">失敗</span>' : '<span class="pending-badge">待送</span>'}</div><div class="item-meta">${esc(row.data?.名稱 || row.data?.["店家／項目"] || row.sync_id)}${row.error ? ` · ${esc(row.error)}` : ""}</div></div><strong>${row.attempts || 0}/3</strong></div>`).join("") : "目前沒有待送資料";
}

const field = (name, label, type = "text", options = {}) => ({ name, label, type, ...options });
const accountFields = [field("名稱", "名稱"), field("類型", "類型", "select", { choices: ["銀行", "現金", "信用卡", "保險", "台股", "美股", "泰國基金", "加密貨幣"] }), field("幣別", "幣別", "select", { choices: ["TWD", "THB", "USD", "JPY"] }), field("國家", "國家"), field("期初餘額", "期初餘額", "number"), field("開帳日", "開帳日", "date"), field("結帳日", "信用卡結帳日", "number"), field("繳款日", "信用卡繳款日", "number"), field("已出帳金額", "已出帳金額", "number"), field("保險種類", "保險種類"), field("計入資產", "保險計入資產", "select", { choices: ["否", "是"] }), field("保單價值", "保單價值", "number"), field("啟用", "啟用", "checkbox", { default: true }), field("備註", "備註", "textarea", { wide: true })];
const holdingFields = [field("名稱", "名稱"), field("代號", "代號"), field("市場", "市場", "select", { choices: ["台股", "美股", "泰國基金", "加密貨幣", "其他"] }), field("計價幣別", "計價幣別", "select", { choices: ["TWD", "THB", "USD", "JPY"] }), field("數量", "數量", "number"), field("平均成本", "平均成本", "number"), field("最新價", "最新價（P1 手動）", "number"), field("帳戶", "所屬帳戶", "relation", { source: "accounts" }), field("定期定額", "定期定額", "checkbox"), field("每期金額", "每期金額", "number"), field("扣款日", "扣款日", "number"), field("扣款帳戶", "扣款帳戶", "relation", { source: "accounts" }), field("啟用", "啟用", "checkbox", { default: true }), field("備註", "備註", "textarea", { wide: true })];
const recurringFields = [field("名稱", "名稱"), field("群組", "群組"), field("週期", "週期", "select", { choices: ["週", "月", "季", "年"] }), field("金額", "金額", "number"), field("幣別", "幣別", "select", { choices: ["TWD", "THB", "USD", "JPY"] }), field("性質", "性質", "select", { choices: ["支出", "轉入資產"] }), field("扣款日", "扣款日", "number"), field("扣款月份", "扣款月份", "number"), field("扣款帳戶", "扣款帳戶", "relation", { source: "accounts" }), field("下次扣款", "下次扣款", "date"), field("對應持倉", "對應持倉", "relation", { source: "holdings" }), field("啟用", "啟用", "checkbox", { default: true }), field("備註", "備註", "textarea", { wide: true })];
const transactionFields = [field("收支", "類型", "hidden"), field("店家／項目", "店家／項目"), field("日期", "日期", "date"), field("原幣金額", "金額", "number"), field("幣別", "幣別", "select", { choices: ["TWD", "THB", "USD", "JPY"] }), field("帳戶", "帳戶", "relation", { source: "accounts" }), field("分類", "分類", "select", { choices: ["餐飲", "交通", "購物", "居住", "娛樂", "醫療", "旅遊", "薪資", "投資", "保險", "其他"] }), field("狀態", "狀態", "select", { choices: ["預估", "已入帳", "已出帳", "已繳款"] }), field("轉入帳戶", "轉入帳戶", "relation", { source: "accounts", types: ["轉帳"] }), field("實扣金額", "實扣金額", "number", { types: ["轉帳", "支出"] }), field("持倉", "持倉", "relation", { source: "holdings", types: ["投資買入", "投資賣出"] }), field("成交數量", "成交數量", "number", { types: ["投資買入", "投資賣出"] }), field("成交單價", "成交單價", "number", { types: ["投資買入", "投資賣出"] }), field("手續費", "手續費", "number", { types: ["投資買入", "投資賣出"] }), field("定期定額", "定期定額", "checkbox", { types: ["投資買入"] }), field("備註", "備註", "textarea", { wide: true })];

function openEditor(kind, record = null, draft = {}) {
  state.editor = { kind, record, draft, transactionType: draft.收支 || record?.p?.收支 || "支出", receiptStatus: "" };
  $("#editor-title").textContent = `${record ? "編輯" : "新增"}${({ account: "帳戶", holding: "持倉", recurring: "固定支出", transaction: "交易" })[kind]}`;
  $("#delete-button").classList.toggle("hidden", !record);
  $("#receipt-button").classList.toggle("hidden", kind !== "transaction");
  renderEditorFields(); $("#editor-dialog").showModal();
}
function renderEditorFields() {
  const { kind, record, transactionType } = state.editor; const data = { ...(record?.p || {}), ...(state.editor.draft || {}) };
  const fields = kind === "account" ? accountFields : kind === "holding" ? holdingFields : kind === "recurring" ? recurringFields : transactionFields;
  const tabs = kind === "transaction" ? `<div class="type-tabs">${["支出", "收入", "轉帳", "投資買入", "投資賣出"].map((type) => `<button type="button" data-transaction-type="${type}" class="${type === transactionType ? "active" : ""}">${type}</button>`).join("")}</div>` : "";
  const receipt = kind === "transaction" ? `<div class="receipt-tools"><strong>📷 收據 AI 辨識</strong>　拍照後只會先填表，不會自動儲存；請確認金額與帳戶。${state.editor.receiptStatus ? `<br>${esc(state.editor.receiptStatus)}` : ""}</div>` : "";
  $("#editor-fields").innerHTML = tabs + receipt + fields.filter((f) => f.type !== "hidden" && (!f.types || f.types.includes(transactionType))).map((f) => renderField(f, data[f.name])).join("") + (kind === "transaction" ? `<input type="hidden" name="收支" value="${esc(transactionType)}">` : "");
}
function renderField(f, value) {
  const className = `${f.wide ? "wide " : ""}${f.type === "checkbox" ? "check" : ""}`;
  if (f.type === "select") return `<label class="${className}">${esc(f.label)}<select name="${esc(f.name)}"><option value="">請選擇</option>${f.choices.map((choice) => `<option ${String(value ?? "") === choice ? "selected" : ""}>${esc(choice)}</option>`).join("")}</select></label>`;
  if (f.type === "relation") {
    const rows = state[f.source] || []; const selected = asArray(value)[0] || "";
    return `<label class="${className}">${esc(f.label)}<select name="${esc(f.name)}"><option value="">無</option>${rows.map((row) => `<option value="${esc(row.id)}" ${selected === row.id ? "selected" : ""}>${esc(row.p?.名稱 || row.p?.["店家／項目"] || row.id)}</option>`).join("")}</select></label>`;
  }
  if (f.type === "checkbox") return `<label class="${className}"><input type="checkbox" name="${esc(f.name)}" ${value ?? f.default ? "checked" : ""}>${esc(f.label)}</label>`;
  if (f.type === "textarea") return `<label class="${className}">${esc(f.label)}<textarea name="${esc(f.name)}" rows="3">${esc(value || "")}</textarea></label>`;
  const fallback = f.type === "date" ? todayISO() : "";
  return `<label class="${className}">${esc(f.label)}<input name="${esc(f.name)}" type="${f.type}" ${f.type === "number" ? 'step="any"' : ""} value="${esc(value ?? fallback)}"></label>`;
}
function collectEditorData() {
  const form = $("#editor-form"); const data = {};
  for (const input of $$('[name]', form)) {
    if (input.type === "checkbox") data[input.name] = input.checked;
    else if (input.type === "number") data[input.name] = input.value === "" ? null : number(input.value);
    else if (RELATION_FIELDS.has(input.name)) data[input.name] = input.value ? [input.value] : [];
    else data[input.name] = input.value;
  }
  return data;
}
async function saveEditor() {
  const { kind, record } = state.editor; const data = collectEditorData(); const table = ({ account: "accounts", holding: "holdings", recurring: "recurring", transaction: "transactions" })[kind];
  if (kind === "transaction") {
    const account = state.accounts.find((x) => hasRelation(data.帳戶, x.id));
    let twd = toTWD(data.原幣金額 || number(data.成交數量) * number(data.成交單價), data.幣別 || "TWD");
    if (data.實扣金額) twd = toTWD(data.實扣金額, account?.p?.幣別 || "TWD");
    if (data.收支 === "支出" && account?.p?.類型 === "信用卡" && data.幣別 !== account.p.幣別 && !data.實扣金額) { twd *= 1.015; data.狀態 = "預估"; }
    data.台幣金額 = Math.round(twd * 100) / 100;
    if (data.收支.startsWith("投資") && data.持倉?.length) await updateHoldingFromTrade(data, record);
  }
  await saveRecord(table, data, record); toast("已先存到本機");
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
  const dataUrl = canvas.toDataURL("image/jpeg", .82); return { mime_type: "image/jpeg", image_base64: dataUrl.split(",")[1] };
}
async function analyzeReceipt(file) {
  if (!file || !state.editor || state.editor.kind !== "transaction") return;
  if (!state.settings.token) { toast("收據辨識需要先在「更多」輸入連線碼"); return; }
  try {
    state.editor.receiptStatus = "正在縮圖並辨識…"; renderEditorFields();
    const image = await resizeReceipt(file); const response = await fetch(endpoint("piggy-receipt"), { method: "POST", headers: apiHeaders(), body: JSON.stringify(image) });
    if (!response.ok) throw new Error(`辨識服務回應 ${response.status}`); const payload = await response.json(); if (!payload.ok) throw new Error(payload.error || "辨識失敗");
    const found = payload.data || payload.result || {}; const allowed = ["店家／項目", "日期", "原幣金額", "幣別", "分類", "備註", "狀態"];
    const current = collectEditorData(); state.editor.draft = { ...state.editor.draft, ...current, ...Object.fromEntries(allowed.filter((key) => found[key] !== undefined && found[key] !== null).map((key) => [key, found[key]])) };
    state.editor.receiptStatus = `辨識完成${found.confidence ? `（信心 ${Math.round(number(found.confidence) * 100)}%）` : ""}，請核對後再儲存。`; renderEditorFields();
  } catch (error) { state.editor.receiptStatus = `辨識失敗：${error.message}`; renderEditorFields(); }
  finally { $("#receipt-input").value = ""; }
}

function openCardDialog(card) {
  const rows = state.transactions.filter((row) => hasRelation(row.p?.帳戶, card.id) && row.p?.收支 === "支出").sort((a, b) => String(b.p?.日期 || "").localeCompare(String(a.p?.日期 || ""))).slice(0, 60);
  $("#card-title").textContent = `${card.p?.名稱 || "信用卡"}對帳`;
  $("#card-content").innerHTML = `<p>銀行入帳後，直接改原交易的實扣金額；系統不會新增第二筆支出。</p>${rows.length ? rows.map((row) => `<div class="reconcile-row"><div><strong>${esc(row.p?.["店家／項目"] || "信用卡消費")}</strong><div class="item-meta">${esc(row.p?.日期 || "")} · ${esc(row.p?.狀態 || "預估")} · 原幣 ${currencySymbol(row.p?.幣別 || "TWD")}${number(row.p?.原幣金額).toLocaleString()}</div></div><label>實扣金額<input data-card-actual="${esc(row.id)}" type="number" step="any" value="${esc(row.p?.實扣金額 ?? "")}" placeholder="銀行入帳金額"></label><button type="button" data-reconcile-save="${esc(row.id)}">確認入帳</button></div>`).join("") : '<div class="empty-state">目前沒有這張卡的消費</div>'}`;
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

function addPeriod(dateText, period) {
  const d = new Date(`${dateText}T12:00:00`); if (period === "週") d.setDate(d.getDate() + 7); else if (period === "季") d.setMonth(d.getMonth() + 3); else if (period === "年") d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1); return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}
async function generateRecurringTransactions() {
  const today = todayISO(); let created = 0;
  for (const rule of state.recurring.filter((row) => row.p?.啟用 !== false && row.p?.下次扣款 && row.p.下次扣款 <= today)) {
    let due = rule.p.下次扣款; let guard = 0;
    while (due <= today && guard++ < 24) {
      const syncId = `recurring-${syncIdFor(rule)}-${due}`; const exists = state.transactions.some((row) => row.p?.同步編號 === syncId || (row.p?.日期 === due && hasRelation(row.p?.固定支出, rule.id)));
      if (!exists) {
        const holding = state.holdings.find((row) => hasRelation(rule.p?.對應持倉, row.id)); const target = asArray(holding?.p?.帳戶);
        const isAsset = rule.p?.性質 === "轉入資產" && target.length;
        await saveRecord("transactions", { 同步編號: syncId, 收支: isAsset ? "轉帳" : "支出", "店家／項目": rule.p?.名稱 || "固定支出", 日期: due, 原幣金額: number(rule.p?.金額), 幣別: rule.p?.幣別 || "TWD", 帳戶: asArray(rule.p?.扣款帳戶), 轉入帳戶: isAsset ? target : [], 固定支出: [rule.id], 分類: rule.p?.群組 || (isAsset ? "投資" : "其他"), 狀態: "已入帳", 備註: `${rule.p?.週期 || "月"}期自動產生` }); created += 1;
      }
      due = addPeriod(due, rule.p?.週期 || "月");
    }
    if (due !== rule.p.下次扣款) await saveRecord("recurring", { 下次扣款: due }, rule);
  }
  if (created) toast(`已自動產生 ${created} 筆到期固定支出`);
}

async function saveTodaySnapshot() {
  const t = totals(); const date = todayISO(); const existing = state.snapshots.find((row) => (row.p?.日期 || row.p?.快照日) === date);
  const values = { 日期: date, 快照日: date, 淨資產TWD: Math.round(t.net), 投資TWD: Math.round(t.investments), USD匯率: rate("USD"), THB匯率: rate("THB"), JPY匯率: rate("JPY"), 抓價狀態: "App 本機快照" };
  await putOne("snapshots", { id: existing?.id || `snapshot-${date}`, edited: existing?.edited || null, p: values });
}
async function refreshPrices() {
  if (!navigator.onLine) return toast("目前離線，保留上次匯率與價格");
  try {
    toast("正在更新匯率與報價…");
    const fx = await fetch("https://open.er-api.com/v6/latest/TWD").then((response) => { if (!response.ok) throw new Error("匯率服務暫時無法使用"); return response.json(); });
    if (fx?.rates) { state.settings = { ...state.settings, rateTHB: 1 / number(fx.rates.THB), rateUSD: 1 / number(fx.rates.USD), rateJPY: 1 / number(fx.rates.JPY), fxUpdatedAt: fx.time_last_update_utc || nowISO() }; await putOne("meta", state.settings); }
    if (state.settings.token && state.holdings.length) {
      const response = await fetch(endpoint("piggy-prices"), { method: "POST", headers: apiHeaders(), body: JSON.stringify({ holdings: state.holdings.map((row) => ({ id: row.id, name: row.p?.名稱, symbol: row.p?.代號, market: row.p?.市場, currency: row.p?.計價幣別, last_price: row.p?.最新價 })) }) });
      if (response.ok) { const payload = await response.json(); for (const quote of payload.quotes || []) { const holding = state.holdings.find((row) => row.id === quote.id); if (holding && quote.price) await saveRecord("holdings", { 最新價: number(quote.price), 價格更新時間: quote.updated_at || nowISO(), 報價來源: quote.source || "自動報價" }, holding); } }
    }
    await loadState(); await saveTodaySnapshot(); await loadState(); render(); toast("匯率與可用報價已更新");
  } catch (error) { toast(`報價更新暫停：${error.message}`); }
}

function openWizard() { state.wizardStep = 0; state.wizardDate = state.accounts.find((a) => a.p?.開帳日)?.p?.開帳日 || todayISO(); renderWizard(); $("#wizard-dialog").showModal(); }
function renderWizard() {
  const steps = 4; $("#wizard-progress").textContent = `${state.wizardStep + 1} / ${steps}`; $("#wizard-prev").disabled = state.wizardStep === 0; $("#wizard-next").textContent = state.wizardStep === 3 ? "完成" : "下一步";
  const el = $("#wizard-content");
  if (state.wizardStep === 0) el.innerHTML = `<div class="wizard-step"><h3>選擇開帳日</h3><p>這一天以前的交易不用補；帳戶從期初餘額開始算。</p><label>開帳日<input id="wizard-date" type="date" value="${esc(state.wizardDate)}"></label></div>`;
  else if (state.wizardStep === 1) el.innerHTML = `<div class="wizard-step"><h3>逐一確認帳戶</h3><p>信用卡填目前未繳總額並加負號；保險填解約金。</p><div class="wizard-rows">${state.accounts.map((row) => `<div class="wizard-row"><div><strong>${esc(row.p?.名稱 || "未命名")}</strong><small>${esc(row.p?.類型 || "帳戶")} · ${esc(row.p?.幣別 || "TWD")}</small></div><input data-wizard-account="${esc(row.id)}" type="number" step="any" value="${esc(row.p?.期初餘額 ?? (row.p?.類型 === "信用卡" ? 0 : ""))}" placeholder="期初餘額"></div>`).join("")}</div></div>`;
  else if (state.wizardStep === 2) el.innerHTML = `<div class="wizard-step"><h3>填寫持倉數量與成本</h3><div class="wizard-rows">${state.holdings.map((row) => `<div class="wizard-row"><div><strong>${esc(row.p?.名稱 || "未命名")}</strong><small>${esc(row.p?.代號 || row.p?.市場 || "")}</small></div><div><input data-wizard-holding-qty="${esc(row.id)}" type="number" step="any" value="${esc(row.p?.數量 ?? "")}" placeholder="數量"><input data-wizard-holding-avg="${esc(row.id)}" type="number" step="any" value="${esc(row.p?.平均成本 ?? "")}" placeholder="平均成本"></div></div>`).join("") || "目前沒有持倉，可稍後新增"}</div></div>`;
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
    const cardAction = event.target.closest("[data-card-action]");
    if (cardAction) { const card = state.accounts.find((row) => row.id === cardAction.dataset.id); if (cardAction.dataset.cardAction === "reconcile") openCardDialog(card); else openCardPayment(card); return; }
    const reconcile = event.target.closest("[data-reconcile-save]"); if (reconcile) { await reconcileTransaction(reconcile.dataset.reconcileSave); return; }
    const edit = event.target.closest("[data-edit]"); if (edit) openEditor(edit.dataset.edit, findRecord(edit.dataset.edit, edit.dataset.id));
    const type = event.target.closest("[data-transaction-type]")?.dataset.transactionType; if (type && state.editor) { state.editor.draft = { ...state.editor.draft, ...collectEditorData(), 收支: type }; state.editor.transactionType = type; renderEditorFields(); }
  });
  $("#editor-dialog").addEventListener("close", async () => { if ($("#editor-dialog").returnValue === "save") await saveEditor(); });
  $("#delete-button").addEventListener("click", async () => {
    const { kind, record } = state.editor; if (!record || !confirm("確定刪除這筆資料？離線時會先排入待送清單。")) return;
    await removeRecord(({ account: "accounts", holding: "holdings", recurring: "recurring", transaction: "transactions" })[kind], record); $("#editor-dialog").close(); toast("已刪除");
  });
  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const settings = { ...state.settings, id: "settings", baseUrl: String(form.get("baseUrl") || DEFAULT_SETTINGS.baseUrl).replace(/\/$/, ""), token: String(form.get("token") || ""), displayCurrency: form.get("displayCurrency") || "TWD", rateTWD: 1, rateTHB: number(form.get("rateTHB")), rateUSD: number(form.get("rateUSD")), rateJPY: number(form.get("rateJPY")) };
    await putOne("meta", settings); await loadState(); render(); toast("設定已儲存在這台裝置"); if (settings.token) void synchronize(false);
  });
  $("#wizard-prev").addEventListener("click", () => { if (state.wizardStep > 0) { state.wizardStep -= 1; renderWizard(); } });
  $("#wizard-next").addEventListener("click", wizardNext);
  $("#receipt-button").addEventListener("click", () => $("#receipt-input").click());
  $("#receipt-input").addEventListener("change", (event) => void analyzeReceipt(event.target.files?.[0]));
  window.addEventListener("online", () => { updateNetworkPill(); void pushOutbox(); });
  window.addEventListener("offline", updateNetworkPill);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void synchronize(false); });
}

async function init() {
  try {
    state.db = await openDatabase(); await loadState(); bindEvents(); render(); switchView("overview");
    await generateRecurringTransactions(); await saveTodaySnapshot(); await loadState(); render();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    if (navigator.onLine && state.settings.token) void synchronize(false);
    const fxAge = Date.now() - Date.parse(state.settings.fxUpdatedAt || "1970-01-01");
    if (navigator.onLine && fxAge > 12 * 3600 * 1000) void refreshPrices();
    setInterval(() => { if (!document.hidden) void synchronize(false); }, 5 * 60 * 1000);
  } catch (error) { console.error(error); document.body.innerHTML = `<main style="margin:2rem"><h1>小豬帳本暫時打不開</h1><p>${esc(error.message)}</p></main>`; }
}
document.addEventListener("DOMContentLoaded", init);
