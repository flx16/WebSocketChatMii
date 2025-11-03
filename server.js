import "dotenv/config";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import fetch from "node-fetch";

// TODO: When receiving Redis events, ensure not to resend events originated by our own user

// --- CONFIGURATION ---
const WS_PORT = process.env.WS_PORT;
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const LARAVEL_API_URL = process.env.LARAVEL_API_URL;

// --- INITIALIZATION ---
const wss = new WebSocketServer({ port: WS_PORT });
const globalRedis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
const clients = new Map(); // userId → { ws, redis, user }

// --- GLOBAL REDIS LOGGING ---
globalRedis.psubscribe("laravel-database-*", (err, count) => {
    if (err) console.error("❌ Global Redis subscription error:", err);
    else console.log(`📡 Global Redis listening on ${count} channels`);
});

globalRedis.on("pmessage", (pattern, channel, message) => {
    console.log("🌍 [GLOBAL REDIS] Message received:", channel);
});

// --- TOKEN VALIDATION ---
async function verifyToken(token) {
    try {
        const res = await fetch(`${LARAVEL_API_URL}/api/me`, {
            method: "GET",
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${token}`,
            },
        });

        console.log("🔎 Checking token... status:", res.status);

        if (!res.ok) {
            console.log("❌ Invalid or expired token");
            return null;
        }

        const data = await res.json();
        const user = data.user || data;
        console.log(`✅ Valid token for ${user.name} (#${user.id})`);
        return user;
    } catch (err) {
        console.error("❌ Token verification error:", err.message);
        return null;
    }
}

// --- 🧩 Subscribe user to channels ---
async function subscribeUserChannels(user, userRedis, ws, channelIds) {
    console.log(`📡 [${user.name}] Subscribing to ${channelIds.length} channels...`);

    // Unsubscribe from all previous channel subscriptions (except personal)
    await userRedis.punsubscribe("laravel-database-private-channel.*");

    // Subscribe again to updated list
    for (const channelId of channelIds) {
        const redisChannel = `laravel-database-private-channel.${channelId}`;
        await userRedis.psubscribe(redisChannel);
        console.log(`   ➕ Subscribed to ${redisChannel}`);
    }
}

// --- WEBSOCKET CONNECTION HANDLER ---
wss.on("connection", (ws, req) => {
    console.log("🌐 New client connected, waiting for authentication...");

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
            user.token = token;

            console.log(`✅ Authenticated as ${user.name} (#${userId})`);

            // --- Redis client for this user ---
            userRedis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

            // Subscribe to personal user channel
            const personalChannel = `laravel-database-private-user.${userId}`;
            await userRedis.psubscribe(personalChannel);
            console.log(`📡 [${user.name}] Subscribed to ${personalChannel}`);

            // --- Handle messages from Redis ---
            userRedis.on("pmessage", async (pattern, channel, message) => {
                console.log(pattern);
                console.log(channel);
                console.log(message);
                try {
                    const payload = JSON.parse(message);

                    // 🧠 RefreshSubList: update subscriptions silently
                    if (payload.event === "RefreshSubList" && payload.data?.channels) {
                        const newChannelIds = payload.data.channels;
                        console.log(`🔁 [${user.name}] RefreshSubList received — re-subscribing to ${newChannelIds.length} channels`);
                        await subscribeUserChannels(user, userRedis, ws, newChannelIds);
                        return; // 🚫 Do not forward this event to the client
                    }

                    // 📦 Forward all other events to the client
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify(payload));
                    }
                } catch (err) {
                    console.error("❌ Redis message parse error:", err);
                }
            });

            // Store connection
            clients.set(userId, { ws, redis: userRedis, user });

            // Confirm authentication to client
            ws.send(JSON.stringify({ success: `Authenticated as ${user.name}`, user }));

            // --- Handle messages from client ---
            ws.on("message", (msg) => {
                try {
                    const parsed = JSON.parse(msg);
                    if (parsed.type === "ping") {
                        ws.send(JSON.stringify({ type: "pong" }));
                    } else {
                        console.log("📦 Message received from client:", parsed);
                    }
                } catch {
                    console.log("💬 Raw message:", msg);
                }
            });

            // --- Handle disconnection ---
            ws.on("close", async () => {
                console.log(`❌ WebSocket disconnected: ${user.name} (#${userId})`);
                clients.delete(userId);
                try {
                    await userRedis.punsubscribe();
                    userRedis.disconnect();
                    console.log(`🧹 Unsubscribed from all Redis channels`);
                } catch (err) {
                    console.error("Cleanup error:", err);
                }
            });
        } catch (err) {
            console.error("❌ Authentication message error:", err);
            ws.send(JSON.stringify({ error: "Bad auth format" }));
            ws.close();
        }
    });
});

console.log(`🚀 WebSocket server running on ws://localhost:${WS_PORT}`);
