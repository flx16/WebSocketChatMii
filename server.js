import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import Redis from "ioredis";

// TODO: When receiving Redis events, ensure not to resend events originated by our own user

// --- CONFIGURATION ---
const WS_PORT = Number(process.env.WS_PORT);
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = Number(process.env.REDIS_PORT);
const LARAVEL_API_URL = process.env.LARAVEL_API_URL;

// --- INITIALIZATION ---
const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });
server.listen(WS_PORT, "0.0.0.0", () => {
    console.log(`🚀 WS up on ws://0.0.0.0:${WS_PORT}`);
});

const globalRedis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
const clients = new Map(); // userId → { ws, redis, user }

// --- GLOBAL REDIS LOGGING ---
globalRedis.psubscribe("laravel-database-*", (err, count) => {
    if (err) console.error("❌ Global Redis subscription error:", err);
    else console.log(`📡 Global Redis listening on ${count} channels`);
});

globalRedis.on("pmessage", (pattern, channel, message) => {
    // console.log("🌍 [GLOBAL REDIS] Message received:", channel);
    console.log("🌍 [GLOBAL REDIS]");
    console.log("   Pattern:", pattern);
    console.log("   Channel:", channel);
    try {
        const parsed = JSON.parse(message);
        console.log("   Event:", parsed.event || "(no event)");
        console.log("   Data:", JSON.stringify(parsed.data, null, 2));
    } catch {
        console.log("   Raw message:", message);
    }
    console.log("──────────────────────────────────────────────");
});

// --- TOKEN VALIDATION ---
async function verifyToken(token) {
    try {
        const res = await fetch(`${LARAVEL_API_URL}/ws/me`, {
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

// --- BROADCAST USER STATUS ---
async function broadcastUserStatus(userId, status, userName) {
    console.log(`📡 Broadcasting status ${status} for user ${userId} (${userName})`);

    // Get user's friends from Laravel API
    let friendIds = [];
    try {
        const client = clients.get(userId.toString());
        if (!client?.user?.token) {
            console.log(`No client or token found for user ${userId}`);
            return;
        }

        const res = await fetch(`${LARAVEL_API_URL}/users/${userId}/friends`, {
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${client.user.token}`,
            },
        });

        if (res.ok) {
            const data = await res.json();
            friendIds = data.data?.map(f => f.id.toString()) || [];
            console.log(`   Found ${friendIds.length} friends`);
        } else {
            console.log(`Failed to fetch friends: ${res.status}`);
        }
    } catch (err) {
        console.error(`Error fetching friends for user ${userId}:`, err.message);
        return;
    }

    // Broadcast to each friend
    const payload = JSON.stringify({
        event: "users.update",
        data: {
            id: parseInt(userId),
            username: userName,
            status: status,
        },
    });

    let sentCount = 0;
    for (const friendId of friendIds) {
        const friendClient = clients.get(friendId);
        if (friendClient?.ws?.readyState === WebSocket.OPEN) {
            friendClient.ws.send(payload);
            sentCount++;
        }
    }
    console.log(`Broadcast sent to ${sentCount}/${friendIds.length} online friends`);
}

// --- SYNC ONLINE FRIENDS STATUS ---
async function syncOnlineFriendsStatus(userId, ws, token) {
    console.log(`Syncing online friends status for user ${userId}`);

    // Get user's friends from Laravel API
    try {
        const res = await fetch(`${LARAVEL_API_URL}/users/${userId}/friends`, {
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${token}`,
            },
        });

        if (!res.ok) {
            console.log(`Failed to fetch friends for sync: ${res.status}`);
            return;
        }

        const data = await res.json();
        const friendIds = data.data?.map(f => f.id.toString()) || [];
        console.log(`Checking ${friendIds.length} friends for online status`);

        let onlineCount = 0;
        // Send status update for each friend that is currently online
        for (const friendId of friendIds) {
            const friendClient = clients.get(friendId);
            if (friendClient?.ws?.readyState === WebSocket.OPEN) {
                const payload = JSON.stringify({
                    event: "users.update",
                    data: {
                        id: parseInt(friendId),
                        username: friendClient.user.name,
                        status: "ONLINE",
                    },
                });
                ws.send(payload);
                onlineCount++;
            }
        }
        console.log(`Sent ${onlineCount} online friend statuses`);
    } catch (err) {
        console.error(`Error syncing friends status for user ${userId}:`, err.message);
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
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(payload));
                    }
                } catch (err) {
                    console.error("❌ Redis message parse error:", err);
                }
            });

            // Store connection
            clients.set(userId, { ws, redis: userRedis, user });

            try {
                await fetch(`${LARAVEL_API_URL}/ws/mychannels`, {
                    method: "GET",
                    headers: {
                        "Accept": "application/json",
                        "Authorization": `Bearer ${token}`,
                    },
                });
            } catch (err) {
                console.error("❌ Error fetching user channels:", err);
            }

            // Confirm authentication to client
            ws.send(JSON.stringify({ success: `Authenticated as ${user.name}`, user }));

            await broadcastUserStatus(userId, "ONLINE", user.name);

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

                await broadcastUserStatus(userId, "OFFLINE", user.name);

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

console.log(`🚀 WebSocket server running on ws://0.0.0.0:${WS_PORT}`);
