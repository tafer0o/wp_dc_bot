require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const FormData = require('form-data');
const http = require('http');


const CONFIG = {
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    WHATSAPP_GROUP_ID: process.env.WHATSAPP_GROUP_ID,
};


const WEBHOOK_URL = CONFIG.DISCORD_WEBHOOK_URL;
const TARGET_GROUP_ID = (CONFIG.WHATSAPP_GROUP_ID || '').trim();

if (!WEBHOOK_URL || WEBHOOK_URL.includes('YOUR_WEBHOOK_ID')) {
    console.error('❌ Error: DISCORD_WEBHOOK_URL is not configured.');
    console.error('   Open index.js and set CONFIG.DISCORD_WEBHOOK_URL.');
    process.exit(1);
}


const DISCORD_MAX_LENGTH = 2000;


const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: '.wwebjs_auth',
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});



client.on('qr', (qr) => {
    console.log('\n📱 Scan the following QR code with WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('✅ WhatsApp authenticated.');
});

client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp authentication failed:', msg);
});

client.on('ready', async () => {
    console.log('🚀 WhatsApp client is ready.');


    await printAllGroups();

    if (!TARGET_GROUP_ID) {
        console.log('\n⚠️  CONFIG.WHATSAPP_GROUP_ID is empty.');
        console.log('   Copy the ID of the group you want from the list above into');
        console.log('   CONFIG.WHATSAPP_GROUP_ID in index.js, then restart.');
        console.log('   No messages will be forwarded until then.');
    } else {
        console.log(`\n🎯 Forwarding messages from group ID: ${TARGET_GROUP_ID}`);
        console.log('   Listening for messages...');
    }
});

client.on('disconnected', (reason) => {
    console.warn('⚠️ WhatsApp disconnected:', reason);
    console.warn('   Restart the process to reconnect.');
});




async function printAllGroups() {
    try {
        const chats = await client.getChats();
        const groups = chats.filter((c) => c.isGroup);

        console.log(`\n📋 Groups this account is in (${groups.length}):`);
        if (groups.length === 0) {
            console.log('   (none)');
            return;
        }

        for (const g of groups) {
            console.log(`   • ${g.name}  →  ${g.id._serialized}`);
        }
    } catch (err) {
        console.error('❌ Failed to list groups:', err.message);
    }
}


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

    // 4. Forward.
    if (msg.hasMedia) {
        await forwardMedia(msg, senderName, contact);
    } else if (body.trim()) {
        await forwardText(senderName, body, contact);
    }
}

/**
 * Get the sender's avatar URL.
 */
async function getAvatarUrl(contact) {
    try {
        const url = await contact.getProfilePicUrl();
        return url || null;
    } catch {
        return null;
    }
}

/**
 * Forward a plain text message.
 */
async function forwardText(senderName, body, contact) {
    const avatarUrl = await getAvatarUrl(contact);
    const chunks = splitMessage(body);

    for (let i = 0; i < chunks.length; i++) {
        const content =
            chunks.length > 1 ? `[${i + 1}/${chunks.length}] ${chunks[i]}` : chunks[i];

        const payload = {
            username: senderName,
            content,
            allowed_mentions: { parse: [] }, // never ping @everyone / @here
        };

        if (avatarUrl) payload.avatar_url = avatarUrl;

        await sendJsonWithRetry(payload);
        console.log(`📤 Text from ${senderName}: ${chunks[i].substring(0, 60)}`);
    }
}

/**
 * Forward a media message (image / video / document).
 */
async function forwardMedia(msg, senderName, contact) {
    let media;
    try {
        media = await msg.downloadMedia();
    } catch (err) {
        console.warn('⚠️ Failed to download media:', err.message);
        return;
    }

    if (!media) {
        console.warn('⚠️ Media download returned nothing, skipping.');
        return;
    }

    const avatarUrl = await getAvatarUrl(contact);
    const caption = (msg.body || '').trim() || `[${media.mimetype}]`;

    const form = new FormData();

    // Discord multipart uploads expect metadata in `payload_json`.
    const payload = {
        username: senderName,
        content: caption.substring(0, DISCORD_MAX_LENGTH),
        allowed_mentions: { parse: [] },
    };
    if (avatarUrl) payload.avatar_url = avatarUrl;

    form.append('payload_json', JSON.stringify(payload));

    const buffer = Buffer.from(media.data, 'base64');
    const filename = media.filename || `file.${getExtension(media.mimetype)}`;

    form.append('files[0]', buffer, {
        filename,
        contentType: media.mimetype,
    });

    await sendFormWithRetry(form);
    console.log(`📤 Media from ${senderName}: ${filename} (${media.mimetype})`);
}

/**
 * MIME → file extension for sensible filenames.
 */
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

/**
 * Split text into chunks ≤ DISCORD_MAX_LENGTH, preferring to break at
 * newlines or spaces near the limit.
 */
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

// ========== Discord sending with 429 retry ==========

async function sendJsonWithRetry(payload, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await axios.post(WEBHOOK_URL, payload, {
                headers: { 'Content-Type': 'application/json' },
                validateStatus: (s) => s < 500,
            });

            if (res.status === 429) {
                const retryAfter = res.data?.retry_after || 1;
                const waitMs = Math.ceil(retryAfter * 1000);
                console.warn(`⏳ Discord rate limit hit. Retrying in ${waitMs}ms...`);
                await sleep(waitMs);
                continue;
            }

            if (res.status >= 400) {
                throw new Error(`Discord responded ${res.status}: ${JSON.stringify(res.data)}`);
            }

            return res;
        } catch (err) {
            if (attempt === maxRetries) throw err;
            console.warn(`⚠️ Send failed. Retrying in 1s (${attempt + 1}/${maxRetries})...`);
            await sleep(1000);
        }
    }
}

async function sendFormWithRetry(form, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await axios.post(WEBHOOK_URL, form, {
                headers: { ...form.getHeaders() },
                validateStatus: (s) => s < 500,
            });

            if (res.status === 429) {
                const retryAfter = res.data?.retry_after || 1;
                const waitMs = Math.ceil(retryAfter * 1000);
                console.warn(`⏳ Discord rate limit hit. Retrying in ${waitMs}ms...`);
                await sleep(waitMs);
                continue;
            }

            if (res.status >= 400) {
                throw new Error(`Discord responded ${res.status}: ${JSON.stringify(res.data)}`);
            }

            return res;
        } catch (err) {
            if (attempt === maxRetries) throw err;
            console.warn(`⚠️ Media send failed. Retrying in 1s (${attempt + 1}/${maxRetries})...`);
            await sleep(1000);
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========== Start ==========
console.log('🔌 Starting WhatsApp client...');
const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WhatsApp to Discord bot is running!');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP server listening on port ${PORT}`);
});
client.initialize();
