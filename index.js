
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const FormData = require('form-data');
const http = require('http');

// ================= CONFIGURATION =================

const CONFIG = {
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    WHATSAPP_GROUP_ID: process.env.WHATSAPP_GROUP_ID,
};

const WEBHOOK_URL = CONFIG.DISCORD_WEBHOOK_URL;
const TARGET_GROUP_ID = (CONFIG.WHATSAPP_GROUP_ID || '').trim();

if (!WEBHOOK_URL || WEBHOOK_URL.includes('YOUR_WEBHOOK_ID')) {
    console.error('❌ DISCORD_WEBHOOK_URL is not configured.');
    process.exit(1);
}

const DISCORD_MAX_LENGTH = 2000;
const MAX_DASHBOARD_MESSAGES = 100;
const dashboardMessages = [];

let whatsappStatus = 'Connecting';

// ================= DASHBOARD MESSAGE STORAGE =================

function addDashboardMessage(message) {
    dashboardMessages.push({
        id: `${Date.now()}-${Math.random()}`,
        timestamp: new Date().toISOString(),
        ...message,
    });

    if (dashboardMessages.length > MAX_DASHBOARD_MESSAGES) {
        dashboardMessages.shift();
    }
}

// ================= WHATSAPP CLIENT =================


const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: '.wwebjs_auth',
    }),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--no-zygote',
            '--renderer-process-limit=1',
        ],
    },
});


client.on('qr', (qr) => {
    whatsappStatus = 'Waiting for QR scan';
    console.log('\n📱 Scan this QR code with WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    whatsappStatus = 'Authenticated';
    console.log('✅ WhatsApp authenticated.');
});

client.on('auth_failure', (msg) => {
    whatsappStatus = 'Authentication failed';
    console.error('❌ WhatsApp authentication failed:', msg);
});

client.on('ready', async () => {
    whatsappStatus = 'Connected';
    console.log('🚀 WhatsApp client is ready.');

    await printAllGroups();

    if (!TARGET_GROUP_ID) {
        console.log('⚠️ WHATSAPP_GROUP_ID is empty. No messages will be forwarded.');
    } else {
        console.log(`🎯 Forwarding from group: ${TARGET_GROUP_ID}`);
    }
});

client.on('disconnected', (reason) => {
    whatsappStatus = 'Disconnected';
    console.warn('⚠️ WhatsApp disconnected:', reason);
});

// ================= LIST GROUPS =================

async function printAllGroups() {
    try {
        const chats = await client.getChats();
        const groups = chats.filter((chat) => chat.isGroup);

        console.log(`\n📋 WhatsApp groups (${groups.length}):`);

        for (const group of groups) {
            console.log(`• ${group.name} → ${group.id._serialized}`);
        }
    } catch (err) {
        console.error('❌ Failed to list groups:', err.message);
    }
}

// ================= RECEIVE MESSAGES =================

client.on('message', async (msg) => {
    try {
        await handleMessage(msg);
    } catch (error) {
        console.error('❌ Error handling message:', error.message);
    }
});

async function handleMessage(msg) {
    if (!TARGET_GROUP_ID) return;
    if (msg.from !== TARGET_GROUP_ID) return;
    if (msg.fromMe) return;

    const contact = await msg.getContact();
    const senderName =
        contact.pushname || contact.name || contact.number || 'Unknown';

    const body = msg.body || '';
    const chat = await msg.getChat();

    // Store the message for the webpage.
    addDashboardMessage({
        sender: senderName,
        group: chat.name || 'WhatsApp Group',
        text: body,
        type: msg.hasMedia ? 'media' : 'text',
        mediaType: msg.hasMedia ? 'Media attachment' : null,
    });

    // Forward to Discord.
    if (msg.hasMedia) {
        await forwardMedia(msg, senderName, contact);
    } else if (body.trim()) {
        await forwardText(senderName, body, contact);
    }
}

// ================= AVATAR =================

async function getAvatarUrl(contact) {
    try {
        return (await contact.getProfilePicUrl()) || null;
    } catch {
        return null;
    }
}

// ================= FORWARD TEXT =================

async function forwardText(senderName, body, contact) {
    const avatarUrl = await getAvatarUrl(contact);
    const chunks = splitMessage(body);

    for (let i = 0; i < chunks.length; i++) {
        const content =
            chunks.length > 1
                ? `[${i + 1}/${chunks.length}] ${chunks[i]}`
                : chunks[i];

        const payload = {
            username: senderName,
            content,
            allowed_mentions: { parse: [] },
        };

        if (avatarUrl) payload.avatar_url = avatarUrl;

        await sendJsonWithRetry(payload);

        console.log(
            `📤 Text from ${senderName}: ${chunks[i].substring(0, 60)}`
        );
    }
}

// ================= FORWARD MEDIA =================

async function forwardMedia(msg, senderName, contact) {
    let media;

    try {
        media = await msg.downloadMedia();
    } catch (err) {
        console.warn('⚠️ Failed to download media:', err.message);
        return;
    }

    if (!media) {
        console.warn('⚠️ Media download returned nothing.');
        return;
    }

    const avatarUrl = await getAvatarUrl(contact);
    const caption = (msg.body || '').trim() || `[${media.mimetype}]`;

    const form = new FormData();

    const payload = {
        username: senderName,
        content: caption.substring(0, DISCORD_MAX_LENGTH),
        allowed_mentions: { parse: [] },
    };

    if (avatarUrl) payload.avatar_url = avatarUrl;

    form.append('payload_json', JSON.stringify(payload));

    const buffer = Buffer.from(media.data, 'base64');
    const filename =
        media.filename || `file.${getExtension(media.mimetype)}`;

    form.append('files[0]', buffer, {
        filename,
        contentType: media.mimetype,
    });

    await sendFormWithRetry(form);

    console.log(
        `📤 Media from ${senderName}: ${filename} (${media.mimetype})`
    );
}

function getExtension(mimetype) {
    const map = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'application/pdf': 'pdf',
    };

    return map[mimetype] || 'bin';
}

// ================= SPLIT LONG MESSAGES =================

function splitMessage(text) {
    if (text.length <= DISCORD_MAX_LENGTH) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= DISCORD_MAX_LENGTH) {
            chunks.push(remaining);
            break;
        }

        let splitIndex = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);

        if (splitIndex === -1 || splitIndex < DISCORD_MAX_LENGTH * 0.5) {
            splitIndex = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH);
        }

        if (splitIndex === -1 || splitIndex < DISCORD_MAX_LENGTH * 0.5) {
            splitIndex = DISCORD_MAX_LENGTH;
        }

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
}

// ================= DISCORD RETRIES =================

async function sendJsonWithRetry(payload, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await axios.post(WEBHOOK_URL, payload, {
                headers: { 'Content-Type': 'application/json' },
                validateStatus: (status) => status < 500,
            });

            if (res.status === 429) {
                const waitMs = Math.ceil(
                    (res.data?.retry_after || 1) * 1000
                );
                console.warn(`⏳ Discord rate limit. Waiting ${waitMs}ms.`);
                await sleep(waitMs);
                continue;
            }

            if (res.status >= 400) {
                throw new Error(`Discord responded ${res.status}`);
            }

            return res;
        } catch (err) {
            if (attempt === maxRetries) throw err;

            console.warn(`⚠️ Send failed. Retry ${attempt + 1}/${maxRetries}.`);
            await sleep(1000);
        }
    }
}

async function sendFormWithRetry(form, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await axios.post(WEBHOOK_URL, form, {
                headers: { ...form.getHeaders() },
                validateStatus: (status) => status < 500,
            });

            if (res.status === 429) {
                const waitMs = Math.ceil(
                    (res.data?.retry_after || 1) * 1000
                );
                console.warn(`⏳ Discord rate limit. Waiting ${waitMs}ms.`);
                await sleep(waitMs);
                continue;
            }

            if (res.status >= 400) {
                throw new Error(`Discord responded ${res.status}`);
            }

            return res;
        } catch (err) {
            if (attempt === maxRetries) throw err;

            console.warn(
                `⚠️ Media send failed. Retry ${attempt + 1}/${maxRetries}.`
            );
            await sleep(1000);
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ================= DECORATED WEB DASHBOARD =================

const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp Bridge</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b1020;color:#e8edf7;font-family:Inter,Segoe UI,Arial,sans-serif}
header{padding:28px 6%;background:#111a2e;border-bottom:1px solid #26324a}
.brand{display:flex;align-items:center;gap:14px}
.logo{background:#16a36a;border-radius:14px;padding:12px;font-size:25px}
h1{font-size:24px;margin:0}
.sub{color:#94a3b8;margin-top:5px;font-size:13px}
main{max-width:900px;margin:30px auto;padding:0 18px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px}
h2{font-size:19px;margin:0}
.status{font-size:12px;background:#172b29;color:#6ee7b7;padding:8px 12px;border-radius:20px}
#feed{display:grid;gap:14px}
.card{background:#121c30;border:1px solid #26324a;border-radius:16px;padding:18px}
.meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.sender{font-weight:700;color:#fff}
.time,.group{font-size:12px;color:#94a3b8}
.group{margin-top:5px}
.message{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;margin-top:15px}
.kind{display:inline-block;margin-top:12px;font-size:11px;color:#a5b4fc;background:#25264a;padding:5px 8px;border-radius:8px}
.empty{text-align:center;padding:55px 20px;border:1px dashed #34425d;border-radius:16px;color:#94a3b8}
footer{text-align:center;color:#64748b;font-size:12px;padding:28px}
@media(max-width:600px){header{padding:22px 18px}h1{font-size:20px}.top{align-items:flex-start}}
</style>
</head>
<body>
<header>
 <div class="brand">
  <div class="logo">☏</div>
  <div>
   <h1>WhatsApp Bridge</h1>
   <div class="sub">WhatsApp → Discord · Message dashboard</div>
  </div>
 </div>
</header>
<main>
 <div class="top">
  <h2>Recent Messages</h2>
  <div class="status" id="status">● Connecting...</div>
 </div>
 <div id="feed"><div class="empty">Waiting for messages...</div></div>
</main>
<footer>Live message feed · Latest 100 messages held in memory</footer>
<script>
let lastSignature = '';

function escapeHTML(value) {
 return String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
 }[c]));
}

async function refresh() {
 try {
  const response = await fetch('/api/messages');
  const data = await response.json();

  const statusResponse = await fetch('/api/status');
  const status = await statusResponse.json();
  document.getElementById('status').textContent = '● ' + status.status;

  const signature = JSON.stringify(data.messages);
  if (signature === lastSignature) return;
  lastSignature = signature;

  const feed = document.getElementById('feed');

  if (!data.messages.length) {
   feed.innerHTML = '<div class="empty">No messages yet. Messages from your selected WhatsApp group will appear here.</div>';
   return;
  }

  feed.innerHTML = data.messages.slice().reverse().map(m => {
   const date = new Date(m.timestamp);
   const time = isNaN(date.getTime()) ? '' : date.toLocaleString();

   return '<article class="card">' +
    '<div class="meta"><span class="sender">' + escapeHTML(m.sender) +
    '</span><span class="time">' + escapeHTML(time) + '</span></div>' +
    '<div class="group">' + escapeHTML(m.group) + '</div>' +
    '<div class="message">' + escapeHTML(m.text || m.mediaType || 'Media message') + '</div>' +
    (m.type === 'media' ? '<span class="kind">📎 Media attachment</span>' : '') +
    '</article>';
  }).join('');
 } catch (e) {
  document.getElementById('status').textContent = '● Reconnecting...';
 }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

// ================= HTTP SERVER =================

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    res.setHeader('Cache-Control', 'no-store');

    if (url.pathname === '/api/messages') {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
        });

        return res.end(JSON.stringify({ messages: dashboardMessages }));
    }

    if (url.pathname === '/api/status') {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
        });

        return res.end(JSON.stringify({ status: whatsappStatus }));
    }

    if (url.pathname === '/') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
        });

        return res.end(dashboardHTML);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Dashboard running on port ${PORT}`);
});

// ================= START BOT =================

console.log('🔌 Starting WhatsApp client...');
client.initialize();
