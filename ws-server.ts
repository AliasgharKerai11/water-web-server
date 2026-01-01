import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "baileys";
import QRCode from "qrcode";
import P from "pino";
import express, { Request, Response } from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";

// ---------------- TYPES ----------------
type QRData =
    | { type: "qr"; data: string | null }
    | { type: "status"; data: string }
    | { type: "info"; data: string | null };

// ---------------- EXPRESS ----------------
const app = express();

// Health check endpoint
app.get("/health", (req, res) => {
    const status = sock?.ws?.isOpen ? "connected" : "disconnected";
    res.status(200).json({
        status: "healthy",
        whatsapp: status,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        wsClients: wss.clients.size,
        hasQR: lastQR !== null,
        lastStatus: lastStatus
    });
});

// CORS configuration
app.use(
    cors({
        origin: true,
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

app.use(express.json());

// ---------------- HTTP SERVER ----------------
const server = http.createServer(app);

// ---------------- WEBSOCKET ----------------
const wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
    clientTracking: true
});

let sock: ReturnType<typeof makeWASocket> | null = null;

// Store last states
let lastQR: string | null = null;
let lastStatus: "connected" | "disconnected" = "disconnected";
let lastInfo: string | null = null;

const broadcast = (message: QRData) => {
    const messageStr = JSON.stringify(message);
    console.log(`📢 Broadcasting to ${wss.clients.size} clients:`, message.type, message.data ? "(has data)" : "(null)");

    wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(messageStr);
            } catch (err) {
                console.error("Failed to send to client:", err);
            }
        }
    });
};

wss.on("connection", (client: WebSocket, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`🧲 WebSocket client connected from ${clientIp}`);
    console.log(`   Total clients: ${wss.clients.size}`);

    // Send current state to new client
    try {
        client.send(JSON.stringify({ type: "status", data: lastStatus }));
        client.send(JSON.stringify({ type: "info", data: lastInfo }));

        if (lastQR) {
            console.log("📱 Sending stored QR to new client");
            client.send(JSON.stringify({ type: "qr", data: lastQR }));
        } else {
            console.log("⚠️ No QR code available to send");
        }
    } catch (err) {
        console.error("Failed to send initial state:", err);
    }

    // Handle client disconnection
    client.on("close", () => {
        console.log(`🔌 Client disconnected. Remaining: ${wss.clients.size}`);
    });

    client.on("error", (err) => {
        console.error("WebSocket client error:", err);
    });

    // Keep-alive ping
    const pingInterval = setInterval(() => {
        if (client.readyState === WebSocket.OPEN) {
            client.ping();
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);
});

// ---------------- API ----------------
app.post("/send", async (req: Request, res: Response) => {
    const { phone, message } = req.body;

    if (!sock || !sock.ws?.isOpen) {
        return res.status(400).json({
            success: false,
            error: "WhatsApp not connected",
        });
    }

    try {
        const formattedPhone = phone.replace(/\D/g, "");
        await sock.sendMessage(`${formattedPhone}@s.whatsapp.net`, {
            text: message,
        });

        res.json({ success: true });
    } catch (err) {
        console.error("❌ Failed to send message:", err);
        res.status(500).json({ success: false, error: String(err) });
    }
});

// API to force logout and generate new QR
app.post("/logout", async (req: Request, res: Response) => {
    try {
        console.log("🚪 Logout requested");
        
        if (sock) {
            await sock.logout();
        }

        // Delete auth folder to force new QR
        const authPath = path.join(process.cwd(), "auth_info_baileys");
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log("🗑️ Deleted auth folder");
        }

        lastQR = null;
        lastStatus = "disconnected";
        lastInfo = null;

        broadcast({ type: "status", data: "disconnected" });
        broadcast({ type: "info", data: null });

        // Restart WhatsApp after 2 seconds
        setTimeout(startWhatsapp, 2000);

        res.json({ success: true, message: "Logged out, generating new QR..." });
    } catch (err) {
        console.error("❌ Logout failed:", err);
        res.status(500).json({ success: false, error: String(err) });
    }
});

// ---------------- WHATSAPP ----------------
let isStarting = false;

const startWhatsapp = async () => {
    if (isStarting) {
        console.log("⏳ WhatsApp is already starting, skipping...");
        return;
    }

    isStarting = true;

    try {
        console.log("🔄 Starting WhatsApp connection...");

        // Ensure auth directory exists
        const authPath = path.join(process.cwd(), "auth_info_baileys");
        if (!fs.existsSync(authPath)) {
            fs.mkdirSync(authPath, { recursive: true });
            console.log("📁 Created auth directory");
        }

        const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
        const { version } = await fetchLatestBaileysVersion();

        console.log("📱 Baileys version:", version.join("."));

        sock = makeWASocket({
            auth: state,
            logger: P({ level: "silent" }),
            version,
            browser: ["Chrome (Linux)", "", ""],
            printQRInTerminal: true, // Also print in terminal for debugging
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
            console.log("🔔 Connection update:", { connection, hasQR: !!qr });

            if (qr) {
                console.log("📱 NEW QR CODE GENERATED!");
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr);
                    lastQR = qrDataUrl;
                    lastStatus = "disconnected"; // Still disconnected until scanned
                    broadcast({ type: "qr", data: qrDataUrl });
                    broadcast({ type: "status", data: "disconnected" });
                    console.log("✅ QR code broadcasted to", wss.clients.size, "clients");
                } catch (err) {
                    console.error("❌ Failed to generate QR:", err);
                }
            }

            if (connection === "open") {
                console.log("✅ WhatsApp connection OPENED!");
                lastQR = null;
                lastStatus = "connected";

                const me = sock?.authState.creds.me;
                lastInfo = me
                    ? `${me.name || "Unknown"} (+${me.id.split(":")[0]})`
                    : "Unknown";

                broadcast({ type: "qr", data: null }); // Clear QR
                broadcast({ type: "status", data: "connected" });
                broadcast({ type: "info", data: lastInfo });

                console.log("✅ WhatsApp connected:", lastInfo);
            }

            if (connection === "close") {
                const reason = (lastDisconnect?.error as any)?.output?.statusCode;
                console.log("❌ WhatsApp connection CLOSED. Reason code:", reason);
                
                lastStatus = "disconnected";
                lastInfo = null;

                broadcast({ type: "status", data: "disconnected" });
                broadcast({ type: "info", data: null });

                const shouldReconnect = reason !== DisconnectReason.loggedOut;
                console.log("Should reconnect:", shouldReconnect);

                if (shouldReconnect) {
                    console.log("🔄 Reconnecting in 5 seconds...");
                    isStarting = false;
                    setTimeout(startWhatsapp, 5000);
                } else {
                    console.log("🚫 Logged out - will generate new QR on next start");
                    // Delete auth to force new QR
                    const authPath = path.join(process.cwd(), "auth_info_baileys");
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                    isStarting = false;
                    setTimeout(startWhatsapp, 2000);
                }
            }
        });

        isStarting = false;
    } catch (err) {
        console.error("❌ Failed to start WhatsApp:", err);
        isStarting = false;
        setTimeout(startWhatsapp, 10000);
    }
};

// ---------------- START SERVER ----------------
const PORT = Number(process.env.PORT || 3001);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔════════════════════════════════════════╗
║  🚀 Server Started Successfully       ║
╠════════════════════════════════════════╣
║  Port: ${PORT.toString().padEnd(31)}║
║  Health: http://0.0.0.0:${PORT}/health${' '.repeat(6)}║
║  WebSocket: Ready                     ║
╚════════════════════════════════════════╝
    `);
    
    // Start WhatsApp connection
    startWhatsapp();
});