import "dotenv/config";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import fetch from "node-fetch";

// --- CONFIGURATION ---
const WS_PORT = process.env.WS_PORT || 8082;
const REDIS_HOST = process.env.REDIS_HOST || "redis";
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const LARAVEL_API_URL = process.env.LARAVEL_API_URL || "http://localhost:8081"; // ton API Laravel locale

// --- INITIALISATION ---
const wss = new WebSocketServer({ port: WS_PORT });
const globalRedis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
const clients = new Map(); // userId → { ws, redis }

console.log(`🚀 Serveur WebSocket sécurisé démarré sur ws://localhost:${WS_PORT}`);

// --- 🔎 LOG GLOBAL : tous les messages Redis ---
globalRedis.psubscribe("laravel-database-*", (err, count) => {
    if (err) console.error("❌ Erreur d'abonnement global Redis:", err);
    else console.log(`📡 Abonnement global Redis activé (${count} canaux)`);
});

globalRedis.on("pmessage", (pattern, channel, message) => {
    console.log("🌍 [GLOBAL REDIS] Nouveau message reçu :");
    console.log("   📡 Canal :", channel);
    try {
        const data = JSON.parse(message);
        console.log("   🧾 Contenu :", JSON.stringify(data, null, 2));
    } catch {
        console.log("   🧾 (Texte brut):", message);
    }
});

// --- FONCTION DE VALIDATION DU TOKEN (JWT) ---
async function verifyToken(token) {
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

        const data = await res.json();
        const user = data.user || data;
        console.log("✅ Token valide pour l'utilisateur:", user.name, `(ID: ${user.id})`);
        return user;
    } catch (err) {
        console.error("❌ Erreur validation token:", err.message);
        return null;
    }
}

// --- GESTION DES CONNEXIONS WEBSOCKET ---
wss.on("connection", (ws, req) => {
    console.log("🌐 Nouveau client connecté en attente d'authentification...");

    let user = null;
    let userRedis = null;
    let userId = null;

    // --- Étape 1 : Attente du message d'authentification ---
    ws.once("message", async (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type !== "auth" || !data.token) {
                ws.send(JSON.stringify({ error: "Unauthorized: no token" }));
                ws.close();
                return;
            }

            user = await verifyToken(data.token);
            if (!user) {
                ws.send(JSON.stringify({ error: "Unauthorized: invalid token" }));
                ws.close();
                return;
            }

            userId = user.id.toString();
            console.log(`✅ Authentifié : ${user.name} (#${userId})`);

            // --- Création d’un client Redis dédié ---
            userRedis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
            const channelName = `laravel-database-private-user.${userId}`;

            await userRedis.psubscribe(channelName);
            console.log(`📡 [${user.name}] Abonné à ${channelName}`);

            // Enregistre la connexion
            clients.set(userId, { ws, redis: userRedis });
            ws.send(JSON.stringify({ success: `Authentifié comme ${user.name}`, user }));

            // --- Redis → WebSocket (spécifique à l'utilisateur) ---
            userRedis.on("pmessage", (pattern, channel, message) => {
                console.log(`📨 [REDIS][${channel}] → ${user.name} (#${userId})`);
                try {
                    const data = JSON.parse(message);
                    console.log("   🧾 Payload:", JSON.stringify(data, null, 2));
                    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
                } catch (err) {
                    console.error("Erreur parsing Redis:", err);
                    console.log("   Message brut:", message);
                }
            });

            // --- Étape 2 : gestion des messages WS envoyés par le client ---
            ws.on("message", (msg) => {
                try {
                    const parsed = JSON.parse(msg);
                    if (parsed.type === "ping") {
                        ws.send(JSON.stringify({ type: "pong" }));
                    } else if (parsed.type === "message") {
                        console.log(`💬 Message utilisateur ${user.name}: ${parsed.content}`);
                        // Tu peux ici rebroadcast via Redis si tu veux
                    } else {
                        console.log("📦 Message inconnu reçu:", parsed);
                    }
                } catch {
                    console.log("💬 Message texte brut:", msg);
                }
            });

            // --- Étape 3 : déconnexion propre ---
            ws.on("close", async () => {
                console.log(`❌ Déconnexion WebSocket : ${user.name} (#${userId})`);
                clients.delete(userId);
                try {
                    if (userRedis) {
                        await userRedis.punsubscribe(`laravel-database-private-user.${userId}`);
                        userRedis.disconnect();
                        console.log(`🧹 Désabonné de ${channelName}`);
                    }
                } catch (err) {
                    console.error("Erreur nettoyage Redis:", err);
                }
            });
        } catch (err) {
            console.error("❌ Erreur auth message:", err);
            ws.send(JSON.stringify({ error: "Bad auth format" }));
            ws.close();
        }
    });
});
