import "dotenv/config";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import fetch from "node-fetch";

//TODO: Lors de la reception d evenements d un channel, il faut verfier que ce n est pas notre id qui est a
// l origine de l evenement pour ne pas renvoyer a soi meme


// --- CONFIGURATION ---
const WS_PORT = process.env.WS_PORT || 8082;
const REDIS_HOST = process.env.REDIS_HOST || "redis";
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const LARAVEL_API_URL = process.env.LARAVEL_API_URL || "http://localhost:8081";

// --- INITIALISATION ---
const wss = new WebSocketServer({ port: WS_PORT });
const globalRedis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
const clients = new Map(); // userId → { ws, redis, user }

// --- LOG GLOBAL ---
globalRedis.psubscribe("laravel-database-*", (err, count) => {
    if (err) console.error("❌ Erreur d'abonnement global Redis:", err);
    else console.log(`📡 Abonnement global Redis activé (${count} canaux)`);
});

globalRedis.on("pmessage", (pattern, channel, message) => {
    console.log("🌍 [GLOBAL REDIS] Nouveau message reçu :", channel);
});

// --- FONCTION DE VALIDATION DU TOKEN ---
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
        console.log(`✅ Token valide pour ${user.name} (#${user.id})`);
        return user;
    } catch (err) {
        console.error("❌ Erreur validation token:", err.message);
        return null;
    }
}

// --- 🧩 NOUVELLE FONCTION : abonner un utilisateur à ses channels ---
async function subscribeUserChannels(user, userRedis, ws, token) {
    try {
        const response = await fetch(`${LARAVEL_API_URL}/api/my-channels-sub`, {
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${token}`, // on stocke le token plus bas
            },
        });

        if (!response.ok) {
            console.error(`❌ Impossible de récupérer les channels de ${user.name}`);
            return;
        }

        const data = await response.json();
        const channelIds = data.channels || [];

        console.log(`📡 [${user.name}] Abonnement à ${channelIds.length} channels...`);

        for (const channelId of channelIds) {
            const redisChannel = `laravel-database-private-channel.${channelId}`;
            await userRedis.psubscribe(redisChannel);
            console.log(`   ➕ Abonné à ${redisChannel}`);

            // Écoute Redis → WS
            userRedis.on("pmessage", (pattern, channel, message) => {
                if (channel === redisChannel && ws.readyState === ws.OPEN) {
                    try {
                        const payload = JSON.parse(message);
                        ws.send(JSON.stringify(payload));
                    } catch {
                        ws.send(message);
                    }
                }
            });
        }
    } catch (err) {
        console.error(`❌ Erreur abonnement channels pour ${user.name}:`, err);
    }
}

// --- GESTION DES CONNEXIONS WEBSOCKET ---
wss.on("connection", (ws, req) => {
    console.log("🌐 Nouveau client connecté en attente d'authentification...");

    let user = null;
    let userRedis = null;
    let userId = null;
    let token = null;

    ws.once("message", async (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type !== "auth" || !data.token) {
                ws.send(JSON.stringify({ error: "Unauthorized: no token" }));
                ws.close();
                return;
            }

            token = data.token;
            user = await verifyToken(token);
            if (!user) {
                ws.send(JSON.stringify({ error: "Unauthorized: invalid token" }));
                ws.close();
                return;
            }

            userId = user.id.toString();
            user.token = token; // on garde le token pour appels futurs

            console.log(`✅ Authentifié : ${user.name} (#${userId})`);

            // --- Redis spécifique à l’utilisateur ---
            userRedis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

            // Abonnement personnel (notifications directes)
            const personalChannel = `laravel-database-private-user.${userId}`;
            await userRedis.psubscribe(personalChannel);
            console.log(`📡 [${user.name}] Abonné à ${personalChannel}`);

            // Abonnement automatique à ses channels non-DM
            await subscribeUserChannels(user, userRedis, ws, token);

            // Enregistre la connexion
            clients.set(userId, { ws, redis: userRedis, user });

            ws.send(JSON.stringify({ success: `Authentifié comme ${user.name}`, user }));

            // --- Messages client ---
            ws.on("message", (msg) => {
                try {
                    const parsed = JSON.parse(msg);
                    if (parsed.type === "ping") {
                        ws.send(JSON.stringify({ type: "pong" }));
                    } else if (parsed.type === "refresh-channels") {
                        // 🔁 possibilité d'appeler la fonction plus tard
                        subscribeUserChannels(user, userRedis, ws);
                    } else {
                        console.log("📦 Message reçu:", parsed);
                    }
                } catch {
                    console.log("💬 Message texte brut:", msg);
                }
            });

            // --- Déconnexion ---
            ws.on("close", async () => {
                console.log(`❌ Déconnexion WebSocket : ${user.name} (#${userId})`);
                clients.delete(userId);
                try {
                    await userRedis.punsubscribe();
                    userRedis.disconnect();
                    console.log(`🧹 Désabonné de tous les canaux Redis`);
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
