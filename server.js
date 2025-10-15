import "dotenv/config";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import fetch from "node-fetch";

// --- CONFIGURATION ---
const WS_PORT = process.env.WS_PORT || 8082;
const REDIS_HOST = process.env.REDIS_HOST || "redis";
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const LARAVEL_API_URL = process.env.LARAVEL_API_URL || "http://laravel.test";

// --- INITIALISATION ---
const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
});

const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Map(); // userId → WebSocket

// --- FONCTION DE VALIDATION DU TOKEN JWT ---
async function verifyToken(token) {
    console.log("token:", token);

    try {
        const res = await fetch(`${LARAVEL_API_URL}/api/me`, {
            method: "GET",
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${token}`,
            },
        });

        console.log("🔎 Vérification du token... status:", res.status);

        if (!res.ok) {
            console.log("❌ Token invalide ou expiré");
            return null;
        }

        const user = await res.json();
        console.log("✅ Token valide pour l'utilisateur:", user);
        return user;
    } catch (err) {
        console.error("❌ Erreur validation token:", err.message);
        return null;
    }
}

// --- GESTION DES CONNEXIONS WEBSOCKET ---
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

    // Lorsqu’un message est reçu du client
    ws.on("message", (msg) => {
        console.log(`💬 Message de ${userId}: ${msg}`);
    });

    // Lorsqu’un client se déconnecte
    ws.on("close", () => {
        clients.delete(userId);
        console.log(`❌ Déconnexion : ${userId}`);
    });
});

// --- ÉCOUTE DES ÉVÉNEMENTS REDIS ---
redis.psubscribe("laravel-database-*");

redis.on("pmessage", (pattern, channel, message) => {
    try {
        const data = JSON.parse(message);
        console.log(`📡 Message reçu via Redis (${channel}):`, data);

        // Envoi ciblé (DM)
        if (data.event === "DirectMessage" && data.data?.toUserId) {
            const ws = clients.get(String(data.data.toUserId));
            if (ws && ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify(data.data));
            }
        }
        // Broadcast global
        else {
            for (const [, ws] of clients.entries()) {
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify(data.data));
                }
            }
        }
    } catch (err) {
        console.error("Erreur parsing Redis:", err);
    }
});

// --- DÉMARRAGE ---
console.log(`🚀 Serveur WebSocket démarré sur ws://localhost:${WS_PORT}`);
