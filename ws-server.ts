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
    | { type: "qr"; data: string }
    | { type: "status"; data: string }
    | { type: "info"; data: string | null };

// ---------------- EXPRESS ----------------
const app = express();
app.use(
    cors({
        origin: [
            "http://localhost:3000",
            "https://zainy-water.vercel.app/",
        ],
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
    })
);
app.use(express.json());

// ---------------- HTTP SERVER ----------------
const server = http.createServer(app);

// ---------------- WEBSOCKET ----------------
const wss = new WebSocketServer({ server });

let sock: ReturnType<typeof makeWASocket> | null = null;

// 🔥 STORE LAST STATES (THIS FIXES RAILWAY)
let lastQR: string | null = null;
let lastStatus: "connected" | "disconnected" = "disconnected";
let lastInfo: string | null = null;

const broadcast = (message: QRData) => {
    wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
};


wss.on("connection", (client: WebSocket) => {
    console.log("🧲 WebSocket client connected");

    client.send(JSON.stringify({ type: "status", data: lastStatus }));
    client.send(JSON.stringify({ type: "info", data: lastInfo }));

    if (lastQR) {
        client.send(JSON.stringify({ type: "qr", data: lastQR }));
    }
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
        res.status(500).json({ success: false });
    }
});

// ---------------- WHATSAPP ----------------
const startWhatsapp = async () => {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        auth: state,
        logger: P({ level: "silent" }),
        version,
        browser: ["Chrome (Linux)", "", ""],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
        if (qr) {
            const qrDataUrl = await QRCode.toDataURL(qr);

            if (qrDataUrl) {
                lastQR = qrDataUrl;
                broadcast({ type: "qr", data: qrDataUrl });
                console.log("📱 QR sent");
            }
        }


        if (connection === "open") {
            lastQR = null;
            lastStatus = "connected";

            const me = sock?.authState.creds.me;
            lastInfo = me
                ? `${me.name || "Unknown"} (+${me.id.split(":")[0]})`
                : "Unknown";

            broadcast({ type: "status", data: lastStatus });
            broadcast({ type: "info", data: lastInfo });

            console.log("✅ WhatsApp connected:", lastInfo);
        }

        if (connection === "close") {
            lastStatus = "disconnected";
            lastInfo = null;

            broadcast({ type: "status", data: lastStatus });
            broadcast({ type: "info", data: null });

            const shouldReconnect =
                (lastDisconnect?.error as any)?.output?.statusCode !== 401;

            console.log("❌ WhatsApp disconnected");

            if (shouldReconnect) {
                setTimeout(startWhatsapp, 5000);
            }
        }
    });
};

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    startWhatsapp();
});
