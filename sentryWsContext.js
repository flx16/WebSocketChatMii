import * as Sentry from "@sentry/node";

export function setupSentryContextForWsConnection(ws, req) {
    const headers = req.headers || {};
    let url;

    try {
        url = new URL(req.url, "https://chatmii.site");
    } catch {
        url = null;
    }

    ws._sentryMeta = {
        conversationId:
            headers["x-conversation-id"] ||
            (url ? url.searchParams.get("conversation_id") : undefined),
        clientVersion:
            headers["x-client-version"] ||
            (url ? url.searchParams.get("client_version") : undefined),
        platform:
            headers["x-client-platform"] ||
            headers["user-agent"],
    };
}

export function withWsSentryScope(ws, fn) {
    Sentry.withScope((scope) => {
        const meta = ws._sentryMeta || {};

        if (meta.conversationId) {
            scope.setTag("conversation_id", String(meta.conversationId));
        }
        if (meta.clientVersion) {
            scope.setTag("client_version", String(meta.clientVersion));
        }
        if (meta.platform) {
            scope.setTag("platform", String(meta.platform).slice(0, 200));
        }

        if (meta.userId) {
            scope.setUser({
                id: meta.userId ? String(meta.userId) : undefined,
            });
        }

        fn()
    });
}
