import makeWASocket, { useMultiFileAuthState } from "baileys";
import QRCode from "qrcode";
import P from "pino";
import express, { Request, Response } from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { fetchLatestBaileysVersion } from "@whiskeysockets/baileys";

// ---------------- TYPES ----------------
type QRData =
    | { type: "qr"; data: string | null }  // allow null
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
        wsClients: wss.clients.size
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
    // Add these options for better Railway compatibility
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
    console.log(`📢 Broadcasting to ${wss.clients.size} clients:`, message.type);

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
    }, 30000); // Every 30 seconds
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

// ---------------- WHATSAPP ----------------
const startWhatsapp = async () => {
    try {
        console.log("🔄 Starting WhatsApp connection...");

        const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            auth: state,
            logger: P({ level: "silent" }), // Changed to silent for production
            version,
            browser: ["Chrome (Linux)", "", ""],
            printQRInTerminal: false, // Disable terminal QR
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
            if (qr) {
                console.log("📱 New QR code generated");
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr);
                    lastQR = qrDataUrl;
                    broadcast({ type: "qr", data: qrDataUrl });
                    console.log("✅ QR code broadcasted to clients");
                } catch (err) {
                    console.error("❌ Failed to generate QR:", err);
                }
            }

            if (connection === "open") {
                console.log("✅ WhatsApp connection opened");
                lastQR = null;
                lastStatus = "connected";

                const me = sock?.authState.creds.me;
                lastInfo = me
                    ? `${me.name || "Unknown"} (+${me.id.split(":")[0]})`
                    : "Unknown";

                broadcast({ type: "status", data: lastStatus });
                broadcast({ type: "info", data: lastInfo });
                broadcast({ type: "qr", data: null }); // Clear QR

                console.log("✅ WhatsApp connected:", lastInfo);
            }

            if (connection === "close") {
                console.log("❌ WhatsApp connection closed");
                lastStatus = "disconnected";
                lastInfo = null;

                broadcast({ type: "status", data: lastStatus });
                broadcast({ type: "info", data: null });

                const shouldReconnect =
                    (lastDisconnect?.error as any)?.output?.statusCode !== 401;

                console.log("Should reconnect:", shouldReconnect);

                if (shouldReconnect) {
                    console.log("🔄 Reconnecting in 5 seconds...");
                    setTimeout(startWhatsapp, 5000);
                } else {
                    console.log("🚫 Not reconnecting (logout detected)");
                }
            }
        });
    } catch (err) {
        console.error("❌ Failed to start WhatsApp:", err);
        setTimeout(startWhatsapp, 10000);
    }
};

// ---------------- START SERVER ----------------
const PORT = Number(process.env.PORT || 3001);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT} (bound to 0.0.0.0)`);
    console.log(`   Health check: http://0.0.0.0:${PORT}/health`);
    console.log(`   WebSocket ready for connections`);
    startWhatsapp();
});