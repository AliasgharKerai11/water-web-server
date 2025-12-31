import makeWASocket, { useMultiFileAuthState } from "baileys";
import QRCode from "qrcode";
import P from "pino";
import { WebSocketServer } from "ws";
import { fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import express, { Request, Response } from "express";
import cors from "cors";
  
// ---------------- TYPES ----------------
type QRData =
    | { type: "qr"; data: string }
    | { type: "status"; data: string }
    | { type: "info"; data: string | null };

// ---------------- WEBSOCKET ----------------
export const wss = new WebSocketServer({ port: 8080 });
console.log("✅ WebSocket server running on ws://localhost:8080");

export let sock: ReturnType<typeof makeWASocket> | null = null;

const broadcast = (message: QRData) => {
    wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
};

// Send current state to new WS clients (ONLY ONCE)
wss.on("connection", (client) => {
    console.log("🧲 WebSocket client connected");

    if (sock?.ws?.isOpen) {
        const me = sock.authState?.creds?.me;
        const accountInfo = me
            ? `${me.name || "Unknown"} (+${me.id.split(":")[0]})`
            : null;

        client.send(JSON.stringify({ type: "status", data: "connected" }));
        if (accountInfo) {
            client.send(JSON.stringify({ type: "info", data: accountInfo }));
        }
    }
});

// ---------------- EXPRESS API ----------------
const app = express();
app.use(cors()); // 👈 THIS LINE FIXES FAILED FETCH

app.use(express.json());

app.post("/send", async (req: Request, res: Response) => {
    const { phone, message } = req.body as {
        phone: string;
        message: string;
    };

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

app.listen(3001, () => {
    console.log("📡 WhatsApp HTTP API running on http://localhost:3001");
});

// ---------------- WHATSAPP ----------------
export const startWhatsapp = async () => {
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
            broadcast({ type: "qr", data: qrDataUrl });
            console.log("📱 QR sent");
        }

        if (connection === "open") {
            const me = sock?.authState.creds.me;
            const accountInfo = me
                ? `${me.name || "Unknown"} (+${me.id.split(":")[0]})`
                : "Unknown";

            broadcast({ type: "status", data: "connected" });
            broadcast({ type: "info", data: accountInfo });

            console.log("✅ WhatsApp connected:", accountInfo);
        }

        if (connection === "close") {
            broadcast({ type: "status", data: "disconnected" });
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

startWhatsapp();
