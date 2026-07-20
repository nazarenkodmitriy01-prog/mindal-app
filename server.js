// ============================================================
// Миндаль — сервер хранения данных (замена Google Apps Script)
// ============================================================
// Полностью повторяет контракт, который уже использует
// payroll_app.html и bron.html, поэтому во фронтенде менять код
// не нужно — только вставить ссылку на этот сервер в настройках.
//
// Что делает:
//  - хранит key-value данные (дни, настройки, график, задачи, чат,
//    брони столов и т.п.) в СЖАТОМ (gzip) JSON-файле на диске — само
//    хранилище данных НИКОГДА не удаляется автоматически, только
//    сжимается для экономии места;
//  - принимает загрузку файлов (вложения к задачам/чату) и раздаёт
//    их обратно по прямой ссылке;
//  - раз в сутки чистит только те загруженные файлы, которые уже
//    нигде не упоминаются ни в одном ключе хранилища (то есть точно
//    больше никому не нужны) — сами данные (брони, ФОТ, задачи,
//    сообщения чата) это не затрагивает никогда.
//
// Диск ограничен (15 ГБ) — отсюда и сжатие с автоочисткой файлов.
//
// Запуск: node server.js  (порт задаётся переменной PORT, по
// умолчанию 3000). Слушает только 127.0.0.1 — наружу его открывает
// nginx (см. инструкцию по установке).
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const iiko = require('./iiko.js');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const KV_FILE_GZ = path.join(DATA_DIR, 'kv.json.gz');
const KV_FILE_LEGACY = path.join(DATA_DIR, 'kv.json'); // несжатый файл из старой версии сервера

// Файлы младше этого возраста НИКОГДА не удаляются автоочисткой, даже если
// формально "не найдены" в ссылках — на случай, если другое устройство ещё
// не успело досинхронизироваться и сослаться на свежезагруженный файл.
const UPLOAD_GC_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // 3 дня

// ---------- Подготовка папок и файла хранения ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- Простое KV-хранилище поверх СЖАТОГО JSON-файла ----------
// Всё держим в памяти и синхронно пишем на диск (в сжатом виде) при каждом
// изменении — для такого объёма данных этого более чем достаточно, и это
// гораздо проще и надёжнее, чем поднимать отдельную СУБД на сервере с 1 ГБ RAM.
// ВАЖНО: сами данные (все ключи kv) никогда и нигде в этом файле не удаляются
// автоматически — только вложенные файлы в uploads/, и то лишь если на них
// нигде больше нет ссылок (см. garbageCollectUploads ниже).
let kv = {};
try {
  if (fs.existsSync(KV_FILE_GZ)) {
    kv = JSON.parse(zlib.gunzipSync(fs.readFileSync(KV_FILE_GZ)).toString('utf8'));
  } else if (fs.existsSync(KV_FILE_LEGACY)) {
    // Миграция с более старой версии сервера, где файл хранился несжатым.
    kv = JSON.parse(fs.readFileSync(KV_FILE_LEGACY, 'utf8') || '{}');
  }
} catch (e) {
  console.error('Не удалось прочитать хранилище, начинаю с пустого:', e);
  kv = {};
}

let saveQueued = false;
function persist() {
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    try {
      // Пишем во временный файл и переименовываем — так при внезапном
      // отключении питания/перезагрузке сервера файл не окажется
      // "битым" (наполовину записанным). Сжимаем gzip — JSON-текст
      // (брони, дни, задачи, переписка) сжимается в разы.
      const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(kv), 'utf8'));
      const tmpFile = KV_FILE_GZ + '.tmp';
      fs.writeFileSync(tmpFile, compressed);
      fs.renameSync(tmpFile, KV_FILE_GZ);
      // Старый несжатый файл больше не нужен, раз миграция прошла успешно.
      if (fs.existsSync(KV_FILE_LEGACY)) fs.unlinkSync(KV_FILE_LEGACY);
    } catch (e) {
      console.error('Ошибка сохранения хранилища:', e);
    }
  });
}

// ---------- Express-приложение ----------
const app = express();

// Тело запроса всегда читаем как обычный текст, независимо от
// Content-Type — фронтенд намеренно шлёт text/plain, чтобы браузер
// не делал предварительный CORS-запрос (preflight). Лимит с запасом
// под картинки в base64 (у них размер в тексте примерно на треть
// больше, чем в байтах).
app.use(express.text({ type: '*/*', limit: '30mb' }));

// CORS — открыто для всех источников, как и было в Apps Script
// (авторизации в системе и так нет, это тот же уровень защиты).
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- GET / — чтение по ключу или список ключей ----------
app.get('/', (req, res) => {
  const { key, action, prefix } = req.query;

  if (action === 'list') {
    const p = prefix || '';
    const keys = Object.keys(kv).filter(k => k.indexOf(p) === 0);
    return res.json({ keys });
  }

  if (!key) return res.json({ error: 'missing_key' });
  const value = Object.prototype.hasOwnProperty.call(kv, key) ? kv[key] : null;
  return res.json({ key, value });
});

// ---------- POST / — запись, удаление, загрузка файла ----------
app.post('/', (req, res) => {
  let body;
  try {
    body = JSON.parse(req.body);
  } catch (e) {
    return res.json({ error: 'bad_request' });
  }

  // --- Загрузка файла ---
  if (body.action === 'uploadFile') {
    try {
      const buffer = Buffer.from(body.dataBase64, 'base64');
      const fileId = crypto.randomBytes(16).toString('hex');
      const ext = (body.filename && path.extname(body.filename)) || '';
      const storedName = fileId + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buffer);

      // Запоминаем оригинальное имя и mime-тип рядом, в самом kv-хранилище,
      // под служебным ключом — чтобы при отдаче файла вернуть браузеру
      // правильные заголовки и красивое имя для скачивания.
      kv['__file_meta:' + storedName] = JSON.stringify({
        name: body.filename || storedName,
        mimeType: body.mimeType || 'application/octet-stream',
      });
      persist();

      const base = PUBLIC_BASE_URL();
      return res.json({
        fileId: storedName,
        name: body.filename || storedName,
        mimeType: body.mimeType || 'application/octet-stream',
        size: buffer.length,
        url: base + '/files/' + storedName,
        viewUrl: base + '/files/' + storedName,
      });
    } catch (e) {
      return res.json({ error: 'upload_failed', message: String(e) });
    }
  }

  // --- Удаление ключа ---
  if (body.action === 'delete') {
    delete kv[body.key];
    persist();
    return res.json({ key: body.key, deleted: true });
  }

  // --- Обычная запись значения ---
  if (typeof body.key === 'undefined') return res.json({ error: 'missing_key' });
  kv[body.key] = body.value;
  persist();
  return res.json({ key: body.key, value: body.value, saved: true });
});

// ---------- Отдача загруженных файлов ----------
app.get('/files/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  // Защита от выхода за пределы папки uploads через "../"
  if (fileId.includes('..') || fileId.includes('/')) return res.sendStatus(400);
  const filePath = path.join(UPLOADS_DIR, fileId);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);

  let meta = { name: fileId, mimeType: 'application/octet-stream' };
  try {
    const raw = kv['__file_meta:' + fileId];
    if (raw) meta = JSON.parse(raw);
  } catch (e) { /* используем имя по умолчанию */ }

  // Telegram (и многие другие внешние сервисы, которые скачивают файл по
  // прямой ссылке) требуют точный Content-Length и корректный ответ на
  // HEAD-запрос — иначе отказываются скачивать с ошибкой
  // "failed to get HTTP URL content", даже если сам файл на самом деле
  // отдаётся нормально через обычный GET из браузера.
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(meta.name) + '"');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(filePath).pipe(res);
});

// ---------- Определяем свой публичный адрес для ссылок на файлы ----------
// Задайте PUBLIC_URL в переменных окружения (см. инструкцию по установке) —
// это тот адрес, по которому сервер виден снаружи (https://ваш-домен-или-ip).
function PUBLIC_BASE_URL() {
  return (process.env.PUBLIC_URL || ('http://' + HOST + ':' + PORT)).replace(/\/$/, '');
}

app.get('/health', (req, res) => {
  res.json({ ok: true, keys: Object.keys(kv).length, diskUsage: diskUsageReport() });
});

// ---------- Автоочистка вложений, на которые больше нет ссылок ----------
// НИКОГДА не трогает сами данные (kv) — только файлы в uploads/, и только
// если ни в одном значении хранилища (брони, задачи, чат, ФОТ и т.п.) больше
// нет упоминания их fileId, и файлу больше UPLOAD_GC_GRACE_MS. Это защищает
// от случайного удаления файла, на который ссылается устройство, ещё не
// успевшее досинхронизироваться.
function garbageCollectUploads() {
  try {
    const allValuesText = Object.entries(kv)
      .filter(([k]) => !k.startsWith('__file_meta:'))
      .map(([, v]) => String(v))
      .join('\n');

    const files = fs.readdirSync(UPLOADS_DIR);
    let removed = 0, freedBytes = 0;
    const now = Date.now();

    files.forEach((fileId) => {
      const filePath = path.join(UPLOADS_DIR, fileId);
      let stat;
      try { stat = fs.statSync(filePath); } catch (e) { return; }
      if (!stat.isFile()) return;
      if (now - stat.mtimeMs < UPLOAD_GC_GRACE_MS) return; // ещё слишком свежий — не трогаем

      const isReferenced = allValuesText.includes(fileId);
      if (isReferenced) return;

      try {
        fs.unlinkSync(filePath);
        delete kv['__file_meta:' + fileId];
        removed++;
        freedBytes += stat.size;
      } catch (e) {
        console.error('Не удалось удалить неиспользуемый файл ' + fileId + ':', e);
      }
    });

    if (removed > 0) {
      persist();
      console.log(`Автоочистка: удалено неиспользуемых файлов — ${removed}, освобождено ${(freedBytes/1024/1024).toFixed(1)} МБ`);
    }
  } catch (e) {
    console.error('Ошибка автоочистки вложений:', e);
  }
}

function folderSizeBytes(dir) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      total += st.isDirectory() ? folderSizeBytes(p) : st.size;
    }
  } catch (e) { /* игнорируем */ }
  return total;
}
function diskUsageReport() {
  const uploadsBytes = folderSizeBytes(UPLOADS_DIR);
  const kvBytes = fs.existsSync(KV_FILE_GZ) ? fs.statSync(KV_FILE_GZ).size : 0;
  return {
    uploadsMB: +(uploadsBytes / 1024 / 1024).toFixed(2),
    kvStoreMB: +(kvBytes / 1024 / 1024).toFixed(2),
    totalMB: +((uploadsBytes + kvBytes) / 1024 / 1024).toFixed(2),
  };
}

// Автоочистка — сразу при старте (на случай долгого простоя без перезапуска)
// и затем раз в сутки.
garbageCollectUploads();
setInterval(garbageCollectUploads, 24 * 60 * 60 * 1000);

// ============================================================
// Интеграция с iiko — синхронизация выручки и накладных
// ============================================================
function todayDateStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Синхронизация конкретного дня, с сохранением результата в общее хранилище
// под ключом iiko-sync:YYYY-MM-DD — оттуда уже читает само приложение.
async function runIikoSync(dateStr) {
  const result = await iiko.syncDay(dateStr);
  kv['iiko-sync:' + dateStr] = JSON.stringify(result);
  persist();
  return result;
}

app.get('/iiko/sync', async (req, res) => {
  if (!iiko.configured()) return res.status(400).json({ error: 'iiko_not_configured', message: 'Заполните IIKO_BASE_URL / IIKO_LOGIN / IIKO_PASSWORD в переменных окружения сервера' });
  const dateStr = req.query.date || todayDateStr();
  try {
    const result = await runIikoSync(dateStr);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Синхронизация целого диапазона дат за один вызов — чтобы заполнить
// пропущенные дни месяца, не вызывая /iiko/sync по одному на каждый день.
app.get('/iiko/sync-range', async (req, res) => {
  if (!iiko.configured()) return res.status(400).json({ error: 'iiko_not_configured' });
  const from = req.query.from;
  const to = req.query.to;
  if (!from || !to) return res.status(400).json({ error: 'missing_from_to', message: 'Укажите ?from=YYYY-MM-DD&to=YYYY-MM-DD' });
  try {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    let cur = new Date(Date.UTC(fy, fm - 1, fd));
    const end = new Date(Date.UTC(ty, tm - 1, td));
    const results = [];
    while (cur <= end) {
      const dateStr = cur.getUTCFullYear() + '-' + String(cur.getUTCMonth() + 1).padStart(2, '0') + '-' + String(cur.getUTCDate()).padStart(2, '0');
      try {
        const r = await runIikoSync(dateStr);
        results.push({ date: dateStr, ok: true, revenue: r.revenue, purchases: r.purchases });
      } catch (e) {
        results.push({ date: dateStr, ok: false, error: String(e.message || e) });
      }
      cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
    }
    res.json({ ok: true, days: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Сумма за месяц по уже засинхронизированным дням (ключи iiko-sync:YYYY-MM-*
// уже лежат в общем хранилище — здесь просто складываем то, что там есть).
app.get('/iiko/month', (req, res) => {
  const month = req.query.month; // YYYY-MM
  if (!month) return res.status(400).json({ error: 'missing_month', message: 'Укажите ?month=YYYY-MM' });
  const prefix = 'iiko-sync:' + month;
  const days = Object.keys(kv).filter((k) => k.indexOf(prefix) === 0);
  const totals = {
    revenueTotal: 0, revenueHookah: 0,
    purchasesBar: 0, purchasesKitchen: 0, purchasesHookah: 0, purchasesHozy: 0,
    daysSynced: 0, daysWithErrors: 0,
  };
  days.forEach((key) => {
    try {
      const parsed = JSON.parse(kv[key]);
      if (parsed.revenue && !parsed.revenue.error) {
        totals.revenueTotal += Number(parsed.revenue.total) || 0;
        totals.revenueHookah += Number(parsed.revenue.hookah) || 0;
      }
      if (parsed.purchases && !parsed.purchases.error && parsed.purchases.byDept) {
        totals.purchasesBar += Number(parsed.purchases.byDept.bar) || 0;
        totals.purchasesKitchen += Number(parsed.purchases.byDept.kitchen) || 0;
        totals.purchasesHookah += Number(parsed.purchases.byDept.hookah) || 0;
        totals.purchasesHozy += Number(parsed.purchases.byDept.hozy) || 0;
      }
      totals.daysSynced++;
    } catch (e) {
      totals.daysWithErrors++;
    }
  });
  res.json({ ok: true, month, ...totals });
});

// Диагностика — проверить, что логин/пароль верны и посмотреть "сырой" ответ
// iiko (полезно, чтобы свериться с точными названиями полей/складов/групп).
app.get('/iiko/diag/ping', async (req, res) => {
  try { res.json(await iiko.diagPing()); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.get('/iiko/diag/sales', async (req, res) => {
  try { res.json(await iiko.diagRawSales(req.query.date || todayDateStr())); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.get('/iiko/diag/transactions', async (req, res) => {
  try { res.json(await iiko.diagRawTransactions(req.query.date || todayDateStr(), req.query.to)); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.get('/iiko/diag/columns', async (req, res) => {
  try { res.json(await iiko.diagColumns(req.query.reportType || 'SALES')); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.get('/iiko/diag/invoices', async (req, res) => {
  try { res.json(await iiko.diagInvoiceDetail(req.query.date || todayDateStr(), req.query.to)); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Автосинхронизация "сегодня" раз в час — чтобы данные в приложении сами
// обновлялись в течение дня, без необходимости нажимать что-либо вручную.
if (iiko.configured()) {
  runIikoSync(todayDateStr()).catch((e) => console.error('iiko: первая синхронизация не удалась:', e.message));
  setInterval(() => {
    runIikoSync(todayDateStr()).catch((e) => console.error('iiko: синхронизация не удалась:', e.message));
  }, 60 * 60 * 1000);
} else {
  console.log('iiko: интеграция не настроена (нет переменных окружения IIKO_*) — пропускаю.');
}

app.listen(PORT, HOST, () => {
  console.log('Миндаль-сервер запущен на ' + HOST + ':' + PORT);
  console.log('Публичный адрес для ссылок на файлы: ' + PUBLIC_BASE_URL());
});
