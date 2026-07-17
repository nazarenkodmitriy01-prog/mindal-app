#!/bin/bash
# ============================================================
# Установка сервера "Миндаль" на чистый Ubuntu-сервер.
# Запускать от root (или через sudo) одной командой:
#   bash install.sh
#
# Что делает по порядку:
#  1. Ставит Node.js, nginx, certbot
#  2. Создаёт /opt/mindal-server с самим сервером
#  3. Настраивает автозапуск через systemd
#  4. Настраивает nginx + бесплатный HTTPS-сертификат (Let's Encrypt)
#     на домен вида 5-129-207-188.sslip.io (автоматически подставляется
#     из IP-адреса сервера — регистрировать ничего не нужно)
#  5. Открывает нужные порты в файрволе (если он включён)
# ============================================================
set -e

echo "=== Определяю IP-адрес сервера и домен sslip.io ==="
SERVER_IP=$(curl -s https://api.ipify.org)
DOMAIN="$(echo "$SERVER_IP" | tr '.' '-').sslip.io"
echo "IP сервера: $SERVER_IP"
echo "Домен (автоматический, бесплатный): $DOMAIN"

echo "=== Устанавливаю Node.js (через NodeSource) ==="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "Node.js уже установлен: $(node -v)"
fi

echo "=== Устанавливаю nginx и certbot ==="
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx

echo "=== Создаю папку приложения /opt/mindal-server ==="
mkdir -p /opt/mindal-server
cd /opt/mindal-server

cat > package.json << 'EOF_PACKAGE'
{
  "name": "mindal-server",
  "version": "1.0.0",
  "description": "Бэкенд хранилища данных для приложения Миндаль",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^4.19.2" }
}
EOF_PACKAGE

cat > server.js << 'EOF_SERVER'
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const KV_FILE = path.join(DATA_DIR, 'kv.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(KV_FILE)) fs.writeFileSync(KV_FILE, '{}', 'utf8');

let kv = {};
try { kv = JSON.parse(fs.readFileSync(KV_FILE, 'utf8') || '{}'); }
catch (e) { console.error('Не удалось прочитать data/kv.json:', e); kv = {}; }

let saveQueued = false;
function persist() {
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    try {
      const tmpFile = KV_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(kv), 'utf8');
      fs.renameSync(tmpFile, KV_FILE);
    } catch (e) { console.error('Ошибка сохранения kv.json:', e); }
  });
}

const app = express();
app.use(express.text({ type: '*/*', limit: '30mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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

function PUBLIC_BASE_URL() {
  return (process.env.PUBLIC_URL || ('http://' + HOST + ':' + PORT)).replace(/\/$/, '');
}

app.post('/', (req, res) => {
  let body;
  try { body = JSON.parse(req.body); }
  catch (e) { return res.json({ error: 'bad_request' }); }

  if (body.action === 'uploadFile') {
    try {
      const buffer = Buffer.from(body.dataBase64, 'base64');
      const fileId = crypto.randomBytes(16).toString('hex');
      const ext = (body.filename && path.extname(body.filename)) || '';
      const storedName = fileId + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buffer);
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

  if (body.action === 'delete') {
    delete kv[body.key];
    persist();
    return res.json({ key: body.key, deleted: true });
  }

  if (typeof body.key === 'undefined') return res.json({ error: 'missing_key' });
  kv[body.key] = body.value;
  persist();
  return res.json({ key: body.key, value: body.value, saved: true });
});

app.get('/files/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  if (fileId.includes('..') || fileId.includes('/')) return res.sendStatus(400);
  const filePath = path.join(UPLOADS_DIR, fileId);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  let meta = { name: fileId, mimeType: 'application/octet-stream' };
  try {
    const raw = kv['__file_meta:' + fileId];
    if (raw) meta = JSON.parse(raw);
  } catch (e) {}
  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(meta.name) + '"');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(filePath).pipe(res);
});

app.get('/health', (req, res) => res.json({ ok: true, keys: Object.keys(kv).length }));

app.listen(PORT, HOST, () => {
  console.log('Миндаль-сервер запущен на ' + HOST + ':' + PORT);
  console.log('Публичный адрес: ' + PUBLIC_BASE_URL());
});
EOF_SERVER

echo "=== Устанавливаю зависимости (npm install) ==="
npm install --production

echo "=== Права доступа ==="
chown -R www-data:www-data /opt/mindal-server

echo "=== Настраиваю systemd-сервис (автозапуск) ==="
cat > /etc/systemd/system/mindal-server.service << EOF_SERVICE
[Unit]
Description=Mindal KV server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mindal-server
ExecStart=/usr/bin/node /opt/mindal-server/server.js
Restart=always
RestartSec=3
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=PUBLIC_URL=https://$DOMAIN
User=www-data

[Install]
WantedBy=multi-user.target
EOF_SERVICE

systemctl daemon-reload
systemctl enable mindal-server
systemctl restart mindal-server
sleep 1
systemctl status mindal-server --no-pager || true

echo "=== Настраиваю nginx ==="
cat > /etc/nginx/sites-available/mindal-server << EOF_NGINX
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 30m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF_NGINX

ln -sf /etc/nginx/sites-available/mindal-server /etc/nginx/sites-enabled/mindal-server
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo "=== Открываю порты в файрволе (если ufw включён) ==="
if command -v ufw >/dev/null 2>&1; then
  ufw allow 'Nginx Full' || true
  ufw allow OpenSSH || true
fi

echo "=== Получаю бесплатный HTTPS-сертификат (Let's Encrypt) ==="
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@"$DOMAIN" --redirect

echo ""
echo "============================================================"
echo "ГОТОВО! Ваш адрес сервера:"
echo "  https://$DOMAIN"
echo ""
echo "Вставьте именно этот адрес в настройки приложения (шестерёнка)."
echo "Проверить, что сервер жив, можно так:"
echo "  curl https://$DOMAIN/health"
echo "============================================================"
