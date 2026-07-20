// ============================================================
// Интеграция с iikoRMS (iikoOffice) — тянет выручку, выручку по
// КАЛЬЯН и накладные по складам напрямую из вашего iiko.
//
// Настройка — через переменные окружения в systemd-сервисе
// (mindal-server.service), НЕ здесь в коде:
//   IIKO_BASE_URL           — напр. https://mindal-house.iiko.it/resto
//   IIKO_LOGIN               — логин пользователя iikoOffice с доступом к API
//   IIKO_PASSWORD             — пароль (можно в открытом виде, скрипт сам
//                                хэширует в SHA1, как требует iiko)
//   IIKO_DISHGROUP_HOOKAH     — точное название группы товаров "Кальян" в iiko
//   IIKO_WAREHOUSE_BAR        — точное название склада для бара
//   IIKO_WAREHOUSE_KITCHEN    — точное название склада для кухни
//   IIKO_WAREHOUSE_HOOKAH     — точное название склада для кальянной
//
// ВАЖНО: названия полей в OLAP-отчёте (DishSumInt, Store.Name и т.п.)
// взяты из стандартного API iikoRMS, но могут чуть отличаться в вашей
// версии — для этого есть диагностический режим (/iiko/diag и
// /iiko/diag/raw), который покажет "сырой" ответ iiko для сверки.
// ============================================================

const crypto = require('crypto');

function cfg() {
  return {
    baseUrl: (process.env.IIKO_BASE_URL || '').replace(/\/$/, ''),
    login: process.env.IIKO_LOGIN || '',
    password: process.env.IIKO_PASSWORD || '',
    hookahDishGroup: process.env.IIKO_DISHGROUP_HOOKAH || 'Кальян',
    warehouses: {
      bar: process.env.IIKO_WAREHOUSE_BAR || '',
      kitchen: process.env.IIKO_WAREHOUSE_KITCHEN || '',
      hookah: process.env.IIKO_WAREHOUSE_HOOKAH || '',
    },
  };
}

function configured() {
  const c = cfg();
  return !!(c.baseUrl && c.login && c.password);
}

function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// iiko требует, чтобы конец периода СТРОГО отличался от начала (не может
// совпадать) — поэтому для "одного дня" всегда берём диапазон
// "с начала этого дня по начало следующего", а не "день - день".
function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

let cachedToken = null;
let tokenObtainedAt = 0;
const TOKEN_TTL_MS = 14 * 60 * 1000; // токены iiko живут около 15 минут — обновляем чуть раньше

async function auth() {
  const c = cfg();
  if (!configured()) throw new Error('iiko не настроен (нет IIKO_BASE_URL / IIKO_LOGIN / IIKO_PASSWORD в переменных окружения сервера)');
  if (cachedToken && (Date.now() - tokenObtainedAt) < TOKEN_TTL_MS) return cachedToken;

  const passHash = sha1(c.password);
  const url = c.baseUrl + '/api/auth?login=' + encodeURIComponent(c.login) + '&pass=' + passHash;
  const res = await fetch(url);
  const text = (await res.text()).trim();
  if (!res.ok || !text || text.indexOf('<') !== -1) {
    throw new Error('Не удалось авторизоваться в iiko: ' + text.slice(0, 300));
  }
  cachedToken = text;
  tokenObtainedAt = Date.now();
  return cachedToken;
}

async function olapReport(token, body) {
  const c = cfg();
  const url = c.baseUrl + '/api/v2/reports/olap?key=' + encodeURIComponent(token);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Ошибка OLAP-отчёта iiko: ' + text.slice(0, 400));
  try { return JSON.parse(text); }
  catch (e) { throw new Error('iiko вернул не-JSON ответ (см. /iiko/diag/raw для разбора): ' + text.slice(0, 400)); }
}

// ---------- Выручка за день: общая и отдельно по группе "Кальян" ----------
async function fetchDayRevenue(dateStr) {
  const c = cfg();
  const token = await auth();
  const report = await olapReport(token, {
    reportType: 'SALES',
    buildSummary: true,
    groupByRowFields: ['DishGroup'],
    groupByColFields: [],
    aggregateFields: ['DishSumInt'],
    filters: {
      'OpenDate.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: dateStr, to: nextDayStr(dateStr) },
    },
  });
  let total = 0, hookah = 0;
  const rows = (report && report.data) || [];
  rows.forEach((r) => {
    const sum = Number(r['DishSumInt']) || 0;
    total += sum;
    const group = String(r['DishGroup'] || '');
    if (group.toLowerCase().indexOf(String(c.hookahDishGroup).toLowerCase()) !== -1) hookah += sum;
  });
  return { total, hookah, rowsCount: rows.length };
}

// ---------- Накладные (приход) по складам за день, разложенные по подразделениям ----------
async function fetchWarehousePurchases(dateStr) {
  const c = cfg();
  const token = await auth();
  const report = await olapReport(token, {
    reportType: 'TRANSACTIONS',
    buildSummary: true,
    groupByRowFields: ['Store.Name', 'TransactionType'],
    groupByColFields: [],
    aggregateFields: ['Sum.Incoming'],
    filters: {
      'DateTime.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: dateStr, to: nextDayStr(dateStr) },
    },
  });
  const byWarehouse = {};
  const rows = (report && report.data) || [];
  rows.forEach((r) => {
    const store = r['Store.Name'];
    const sum = Number(r['Sum.Incoming']) || 0;
    if (!store) return;
    byWarehouse[store] = (byWarehouse[store] || 0) + sum;
  });
  const result = { bar: 0, kitchen: 0, hookah: 0 };
  Object.keys(c.warehouses).forEach((dept) => {
    const whName = c.warehouses[dept];
    if (whName && byWarehouse[whName] != null) result[dept] = byWarehouse[whName];
  });
  return { byDept: result, byWarehouseRaw: byWarehouse, rowsCount: rows.length };
}

// ---------- Полная синхронизация за один день ----------
async function syncDay(dateStr) {
  const [revenue, purchases] = await Promise.all([
    fetchDayRevenue(dateStr).catch((e) => ({ error: String(e.message || e) })),
    fetchWarehousePurchases(dateStr).catch((e) => ({ error: String(e.message || e) })),
  ]);
  return { date: dateStr, revenue, purchases, syncedAt: new Date().toISOString() };
}

// ---------- Диагностика — проверить связь и посмотреть "сырой" ответ ----------
async function diagPing() {
  const token = await auth();
  return { ok: true, tokenReceived: !!token, baseUrl: cfg().baseUrl };
}
async function diagRawSales(dateStr) {
  const token = await auth();
  return olapReport(token, {
    reportType: 'SALES',
    buildSummary: true,
    groupByRowFields: ['DishGroup'],
    groupByColFields: [],
    aggregateFields: ['DishSumInt'],
    filters: {
      'OpenDate.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: dateStr, to: nextDayStr(dateStr) },
    },
  });
}
async function diagRawTransactions(dateStr) {
  const token = await auth();
  return olapReport(token, {
    reportType: 'TRANSACTIONS',
    buildSummary: true,
    groupByRowFields: ['Store.Name', 'TransactionType'],
    groupByColFields: [],
    aggregateFields: ['Sum.Incoming'],
    filters: {
      'DateTime.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: dateStr, to: nextDayStr(dateStr) },
    },
  });
}

module.exports = {
  configured,
  auth,
  olapReport,
  fetchDayRevenue,
  fetchWarehousePurchases,
  syncDay,
  diagPing,
  diagRawSales,
  diagRawTransactions,
};
