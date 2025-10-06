import "dotenv/config";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import fetch from "node-fetch";

// --- CONFIGURATION ---
const WS_PORT = process.env.WS_PORT || 8082;
const REDIS_HOST = process.env.REDIS_HOST || "redis";
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const LARAVEL_API_URL = process.env.LARAVEL_API_URL || "http://laravel.test";

const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
});

const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Map(); // userId → ws

// Vérifie le token Sanctum auprès de Laravel
async function verifyToken(token) {
    try {
        const res = await fetch(`${LARAVEL_API_URL}/api/user`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.error("❌ Erreur validation token:", err.message);
        return null;
    }
}

// Quand un client se connecte
wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    const user = await verifyToken(token);
    if (!user) {
        ws.send(JSON.stringify({ error: "Unauthorized" }));
        ws.close();
        return;
    }

    const userId = user.id.toString();
    clients.set(userId, ws);
    console.log(`✅ Utilisateur connecté : ${userId}`);

    ws.on("message", (msg) => {
        console.log(`💬 Message de ${userId}: ${msg}`);
    });

    ws.on("close", () => {
        clients.delete(userId);
        console.log(`❌ Déconnexion : ${userId}`);
    });
});

// Écoute les événements Redis publiés depuis Laravel
redis.psubscribe("laravel-database-*");
redis.on("pmessage", (pattern, channel, message) => {
    try {
        const data = JSON.parse(message);
        console.log(`📡 Message reçu via Redis (${channel}):`, data);

        // Envoi à un utilisateur précis
        if (data.event === "DirectMessage" && data.data?.toUserId) {
            const ws = clients.get(String(data.data.toUserId));
            if (ws && ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify(data.data));
            }
        }
        // Broadcast général
        else {
            for (const [, ws] of clients.entries()) {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data.data));
            }
        }
    } catch (err) {
        console.error("Erreur parsing Redis:", err);
    }
});

console.log(`🚀 Serveur WebSocket démarré sur ws://localhost:${WS_PORT}`);
