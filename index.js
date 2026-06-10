const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Store active sockets and QR codes in memory
const sessions = {};
const qrCodes = {};

async function startSession(tenantId) {
    const sessionDir = `./sessions/tenant_${tenantId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Don't print in terminal, send to Flutter App instead
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`[Tenant ${tenantId}] QR Code Generated. Ready for app to scan.`);
            // Save QR string to be fetched via API by Flutter
            qrCodes[tenantId] = qr;
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[Tenant ${tenantId}] Connection closed. Reconnecting:`, shouldReconnect);
            if (shouldReconnect) {
                startSession(tenantId);
            } else {
                delete sessions[tenantId];
                delete qrCodes[tenantId];
                // User explicitly logged out from their phone. Delete session data.
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            console.log(`[Tenant ${tenantId}] WhatsApp connection opened successfully!`);
            delete qrCodes[tenantId]; // Connected, no longer need QR
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    sessions[tenantId] = sock;
    return sock;
}

// -----------------------------------------------------
// API Endpoints for Multi-Tenant WhatsApp Operations
// -----------------------------------------------------

// Initialize session and get QR
app.post('/wa/api/whatsapp/init', async (req, res) => {
    const { tenant_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

    if (!sessions[tenant_id]) {
        await startSession(tenant_id);
        // Wait briefly for the QR code to be emitted by the socket
        await new Promise(resolve => setTimeout(resolve, 2500)); 
    }

    const sock = sessions[tenant_id];
    if (sock?.user) {
        return res.json({ status: 'connected', user: sock.user });
    }

    if (qrCodes[tenant_id]) {
        return res.json({ status: 'qr_ready', qr: qrCodes[tenant_id] });
    }

    res.json({ status: 'initializing' });
});

// Check connection status
app.get('/wa/api/whatsapp/status/:tenant_id', (req, res) => {
    const tenantId = req.params.tenant_id;
    const sock = sessions[tenantId];
    
    if (sock?.user) {
        return res.json({ connected: true, user: sock.user });
    }
    
    if (qrCodes[tenantId]) {
        return res.json({ connected: false, qr: qrCodes[tenantId] });
    }
    
    res.json({ connected: false, status: 'not_initialized' });
});

// Send Message securely using the correct tenant's session
app.post('/wa/api/send-message', async (req, res) => {
    try {
        const { tenant_id, phone, message } = req.body;
        
        if (!tenant_id || !phone || !message) {
            return res.status(400).json({ error: 'tenant_id, phone, and message are required' });
        }
        
        const sock = sessions[tenant_id];
        if (!sock || !sock.user) {
            return res.status(400).json({ error: 'WhatsApp is not connected for this store. Please scan QR first.' });
        }

        // Format phone number to standard WhatsApp JID
        const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        
        res.json({ success: true, message: 'Message sent successfully via tenant session' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

// Start all previously saved active sessions on server boot
function boot() {
    if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions');
    
    const folders = fs.readdirSync('./sessions', { withFileTypes: true });
    for (const folder of folders) {
        if (folder.isDirectory() && folder.name.startsWith('tenant_')) {
            const tenantId = folder.name.split('_')[1];
            console.log(`[Boot] Restoring session for Tenant ${tenantId}...`);
            startSession(tenantId);
        }
    }
}

boot();

app.listen(PORT, () => {
    console.log(`[Taswiyah AI] WhatsApp Multi-Tenant Gateway Server running on http://localhost:${PORT}`);
});
