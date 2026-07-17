// ============================================================
// Миндаль — сервер хранения данных (замена Google Apps Script)
// ============================================================
// Полностью повторяет контракт, который уже использует
// payroll_app.html, поэтому во фронтенде менять код не нужно —
// только вставить ссылку на этот сервер в настройках (шестерёнка).
//
// Что делает:
//  - хранит key-value данные (дни, настройки, график, задачи, чат
//    и т.п.) в простом JSON-файле на диске;
//  - принимает загрузку файлов (вложения к задачам/чату, картинки
//    чека для Telegram) и раздаёт их обратно по прямой ссылке.
//
// Запуск: node server.js  (порт задаётся переменной PORT, по
// умолчанию 3000). Слушает только 127.0.0.1 — наружу его открывает
// nginx (см. инструкцию по установке).
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const KV_FILE = path.join(DATA_DIR, 'kv.json');

// ---------- Подготовка папок и файла хранения ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(KV_FILE)) fs.writeFileSync(KV_FILE, '{}', 'utf8');

// ---------- Простое KV-хранилище поверх JSON-файла ----------
// Всё держим в памяти и синхронно пишем на диск при каждом изменении —
// для такого объёма данных (одна небольшая точка общепита) этого более
// чем достаточно, и это гораздо проще и надёжнее, чем поднимать
// отдельную СУБД на сервере с 1 ГБ RAM.
let kv = {};
try {
  kv = JSON.parse(fs.readFileSync(KV_FILE, 'utf8') || '{}');
} catch (e) {
  console.error('Не удалось прочитать data/kv.json, начинаю с пустого хранилища:', e);
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
      // "битым" (наполовину записанным).
      const tmpFile = KV_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(kv), 'utf8');
      fs.renameSync(tmpFile, KV_FILE);
    } catch (e) {
      console.error('Ошибка сохранения kv.json:', e);
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

app.get('/health', (req, res) => res.json({ ok: true, keys: Object.keys(kv).length }));

app.listen(PORT, HOST, () => {
  console.log('Миндаль-сервер запущен на ' + HOST + ':' + PORT);
  console.log('Публичный адрес для ссылок на файлы: ' + PUBLIC_BASE_URL());
});
