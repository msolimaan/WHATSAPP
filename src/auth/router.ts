import { createHash, timingSafeEqual } from "node:crypto";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express, { type RequestHandler, type Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Config } from "../config.js";
import type { DB } from "../store/db.js";
import { renderLogin, renderMessage } from "./page.js";
import { OwnerOAuthProvider } from "./provider.js";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Compares passwords in constant time (both sides hashed to the same length first). */
export function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

// After this many wrong passwords in an hour (from anywhere), logins pause for the rest of the hour.
const GLOBAL_FAILURES_PER_HOUR = 20;

export interface AuthSetup {
  /** OAuth endpoints and the login page; mount at the app root. */
  router?: Router;
  /** Protects /mcp; undefined when no way to log in is configured. */
  guard?: RequestHandler;
  provider?: OwnerOAuthProvider;
}

export function setupAuth(config: Config, db: DB, opts: { now?: () => number } = {}): AuthSetup {
  const oauth = Boolean(config.OWNER_PASSWORD && config.PUBLIC_BASE_URL);
  if (!oauth && !config.MCP_BEARER_TOKEN) return {};

  const base = new URL(config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`);
  const resource = new URL("/mcp", base);
  const provider = new OwnerOAuthProvider(db, {
    resource,
    allowedRedirectHosts: config.OAUTH_ALLOWED_REDIRECT_HOSTS,
    accessTtlSeconds: config.OAUTH_ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshTtlSeconds: config.OAUTH_REFRESH_TOKEN_TTL_DAYS * 86400,
    staticToken: config.MCP_BEARER_TOKEN,
    now: opts.now,
  });
  const resourceMetadataUrl = oauth ? getOAuthProtectedResourceMetadataUrl(resource) : undefined;
  const guard = requireBearerAuth({ verifier: provider, resourceMetadataUrl });
  if (!oauth) return { guard, provider };

  const router = express.Router();
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: base,
      resourceServerUrl: resource,
      resourceName: "WhatsApp (Inhouse Creatives)",
    }),
  );

  const failures: number[] = [];
  router.post(
    "/oauth/login",
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: "4kb" }),
    (req, res) => {
      const id = typeof req.body?.request === "string" ? req.body.request : "";
      const pending = provider.pending(id);
      if (!pending) {
        return renderMessage(res, 400, "Login expired", "This login request expired or was already used. Start again from the Claude app.");
      }
      if (req.body.decision === "deny") {
        return res.redirect(302, provider.deny(id)!);
      }
      const now = Date.now();
      while (failures.length && failures[0] < now - 3600_000) failures.shift();
      if (failures.length >= GLOBAL_FAILURES_PER_HOUR) {
        return renderLogin(res, { pendingId: id, pending, status: 429, error: "Too many wrong passwords. Logins are paused for up to an hour." });
      }
      const password = typeof req.body.password === "string" ? req.body.password : "";
      if (!passwordMatches(password, config.OWNER_PASSWORD!)) {
        failures.push(now);
        return renderLogin(res, { pendingId: id, pending, status: 401, error: "Wrong password." });
      }
      return res.redirect(302, provider.approve(id));
    },
  );
  return { router, guard, provider };
}
