/**
 * Traefik forwardAuth gate for the Anna's Archive API.
 *
 * The upstream service already refuses requests without a valid Anna's Archive key, but it
 * would accept anyone's key: the point of this gate is that only the owner's key gets through,
 * so the box cannot be used as a public scraping relay. Traefik calls `GET /check` with the
 * original request headers; a 200 lets the request through to the API unchanged.
 *
 * Only `sha256(<key>)` is stored on the server (`ANNAS_KEY_SHA256` in `.env`), never the key.
 * Start-up fails closed: without a valid hash the gate serves nothing but 401s.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** Lowercase hex SHA-256 of `text`. */
export function sha256(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Is `header` a Bearer token whose SHA-256 is `expected`?
 * `expected` is the 64 hex characters of `sha256(key)`.
 */
export function authorized(header, expected) {
    if (typeof header !== "string" || typeof expected !== "string") return false;
    if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
    if (!match) return false;
    const got = Buffer.from(sha256(match[1]), "hex");
    const want = Buffer.from(expected.toLowerCase(), "hex");
    return got.length === want.length && timingSafeEqual(got, want);
}

function reply(res, status, body = "") {
    res.writeHead(status, body ? { "content-type": "application/json" } : {});
    res.end(body);
}

export function handler(expected) {
    return (req, res) => {
        const path = (req.url || "").split("?")[0];
        if (path === "/health") return reply(res, 200, '{"ok":true}');
        if (path !== "/check") return reply(res, 404, '{"error":"not found"}');
        if (authorized(req.headers.authorization, expected)) return reply(res, 200);
        return reply(res, 401, '{"error":"unauthorized"}');
    };
}

function start() {
    const expected = (process.env.ANNAS_KEY_SHA256 || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
        console.error(
            "annas-gate: ANNAS_KEY_SHA256 must hold the 64 hex characters of `sha256(<key>)`; refusing to start.",
        );
        process.exit(1);
    }
    const port = Number(process.env.PORT || 8080);
    createServer(handler(expected)).listen(port, "0.0.0.0", () => {
        console.log(`annas-gate: listening on ${port}, only the owner's key passes`);
    });
}

// Importing this file (tests) must not start a server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();