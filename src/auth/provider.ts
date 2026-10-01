import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import type { DB } from "../store/db.js";
import { renderLogin } from "./page.js";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

const PENDING_TTL = 10 * 60;
const CODE_TTL = 5 * 60;
const MAX_CLIENTS = 100;

export interface PendingAuthorization {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
}

export interface ProviderOptions {
  /** The MCP endpoint these tokens are for (RFC 8707 resource), e.g. https://host/mcp */
  resource: URL;
  allowedRedirectHosts: string[];
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Static token for clients that send their own header (Claude Code). */
  staticToken?: string;
  now?: () => number;
}

export function hostAllowed(uri: string, allowed: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  // Remote hosts must use https; only loopback callbacks (desktop apps) may use http.
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return false;
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

/**
 * OAuth 2.1 for one owner. Any Claude app can register (dynamic client registration), but
 * an authorization only completes after the owner types their password on the login page,
 * and logins can only be returned to allowed hosts (claude.ai, claude.com, local apps).
 */
export class OwnerOAuthProvider implements OAuthServerProvider {
  private readonly now: () => number;

  constructor(
    private readonly db: DB,
    private readonly opts: ProviderOptions,
  ) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => {
        const row = this.db.prepare(`SELECT info FROM oauth_clients WHERE client_id = ?`).get(clientId) as { info: string } | undefined;
        return row ? (JSON.parse(row.info) as OAuthClientInformationFull) : undefined;
      },
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        const bad = full.redirect_uris.filter((u) => !hostAllowed(u, this.opts.allowedRedirectHosts));
        if (bad.length) {
          throw new InvalidClientMetadataError(
            `redirect_uri not allowed: ${bad.join(", ")}. Only ${this.opts.allowedRedirectHosts.join(", ")} (https, or http on localhost) can receive logins.`,
          );
        }
        const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`).get() as { n: number }).n;
        if (count >= MAX_CLIENTS) {
          // Drop the oldest client that never got a token, to stop registration spam filling the table.
          const removed = this.db
            .prepare(
              `DELETE FROM oauth_clients WHERE client_id = (
                 SELECT c.client_id FROM oauth_clients c
                 WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.client_id)
                 ORDER BY c.created_at LIMIT 1)`,
            )
            .run();
          if (removed.changes === 0) throw new InvalidClientMetadataError("Too many registered clients.");
        }
        this.db
          .prepare(`INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)`)
          .run(full.client_id, JSON.stringify(full), this.now());
        return full;
      },
    };
  }

  /** Shows the owner a password page instead of approving straight away. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    this.cleanup();
    const id = secret();
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      clientName: client.client_name ?? "An app",
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
    };
    this.db
      .prepare(`INSERT INTO oauth_pending (id, client_id, params, expires_at) VALUES (?, ?, ?, ?)`)
      .run(hash(id), client.client_id, JSON.stringify(pending), this.now() + PENDING_TTL);
    renderLogin(res, { pendingId: id, pending });
  }

  pending(id: string): PendingAuthorization | undefined {
    const row = this.db
      .prepare(`SELECT params, expires_at FROM oauth_pending WHERE id = ?`)
      .get(hash(id)) as { params: string; expires_at: number } | undefined;
    if (!row || row.expires_at < this.now()) return undefined;
    return JSON.parse(row.params) as PendingAuthorization;
  }

  /** After the owner's password is accepted: issue a one-time code and return where to send it. */
  approve(id: string): string {
    const p = this.pending(id);
    if (!p) throw new InvalidGrantError("This login request expired. Start again from the Claude app.");
    this.db.prepare(`DELETE FROM oauth_pending WHERE id = ?`).run(hash(id));
    const code = secret();
    this.db
      .prepare(`INSERT INTO oauth_codes (code_hash, client_id, params, expires_at) VALUES (?, ?, ?, ?)`)
      .run(hash(code), p.clientId, JSON.stringify(p), this.now() + CODE_TTL);
    const url = new URL(p.redirectUri);
    url.searchParams.set("code", code);
    if (p.state) url.searchParams.set("state", p.state);
    return url.href;
  }

  /** The owner said no: tell the app. */
  deny(id: string): string | undefined {
    const p = this.pending(id);
    if (!p) return undefined;
    this.db.prepare(`DELETE FROM oauth_pending WHERE id = ?`).run(hash(id));
    const url = new URL(p.redirectUri);
    url.searchParams.set("error", "access_denied");
    if (p.state) url.searchParams.set("state", p.state);
    return url.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.code(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const p = this.code(client, code);
    // Codes are single-use: delete before issuing so a replay can't get a second token pair.
    this.db.prepare(`DELETE FROM oauth_codes WHERE code_hash = ?`).run(hash(code));
    if (redirectUri && redirectUri !== p.redirectUri) throw new InvalidGrantError("redirect_uri doesn't match the authorization request");
    this.checkResource(resource);
    return this.issue(client.client_id, randomUUID(), p.scopes, resource?.href ?? p.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const row = this.token(refreshToken, "refresh");
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    if (row.used) {
      // A refresh token was used twice: someone may have stolen it. End this login everywhere.
      this.db.prepare(`DELETE FROM oauth_tokens WHERE family = ?`).run(row.family);
      throw new InvalidGrantError("Refresh token was already used; please sign in again");
    }
    if (row.expires_at < this.now()) throw new InvalidGrantError("Refresh token expired; please sign in again");
    this.checkResource(resource);
    const granted = JSON.parse(row.scopes) as string[];
    if (scopes?.some((s) => !granted.includes(s))) throw new InvalidGrantError("Can't widen scopes on refresh");
    this.db.prepare(`UPDATE oauth_tokens SET used = 1 WHERE token_hash = ?`).run(hash(refreshToken));
    // Old access tokens of this login stop working once a new pair is issued.
    this.db.prepare(`DELETE FROM oauth_tokens WHERE family = ? AND kind = 'access'`).run(row.family);
    return this.issue(client.client_id, row.family, scopes ?? granted, resource?.href ?? row.resource ?? undefined);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.opts.staticToken && hash(token) === hash(this.opts.staticToken)) {
      return { token, clientId: "static-token", scopes: [], expiresAt: this.now() + 3600, resource: this.opts.resource };
    }
    const row = this.token(token, "access");
    if (!row || row.expires_at < this.now()) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: row.client_id,
      scopes: JSON.parse(row.scopes) as string[],
      expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = this.db
      .prepare(`SELECT family, client_id FROM oauth_tokens WHERE token_hash = ?`)
      .get(hash(request.token)) as { family: string; client_id: string } | undefined;
    if (row && row.client_id === client.client_id) this.db.prepare(`DELETE FROM oauth_tokens WHERE family = ?`).run(row.family);
  }

  /** Signs every app out (e.g. after changing the password). */
  revokeAll(): number {
    return this.db.prepare(`DELETE FROM oauth_tokens`).run().changes;
  }

  private issue(clientId: string, family: string, scopes: string[], resource?: string): OAuthTokens {
    const access = secret();
    const refresh = secret();
    const now = this.now();
    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, family, scopes, resource, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      insert.run(hash(access), "access", clientId, family, JSON.stringify(scopes), resource ?? null, now + this.opts.accessTtlSeconds, now);
      insert.run(hash(refresh), "refresh", clientId, family, JSON.stringify(scopes), resource ?? null, now + this.opts.refreshTtlSeconds, now);
    })();
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: this.opts.accessTtlSeconds,
      refresh_token: refresh,
      ...(scopes.length && { scope: scopes.join(" ") }),
    };
  }

  private code(client: OAuthClientInformationFull, code: string): PendingAuthorization {
    const row = this.db
      .prepare(`SELECT client_id, params, expires_at FROM oauth_codes WHERE code_hash = ?`)
      .get(hash(code)) as { client_id: string; params: string; expires_at: number } | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < this.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return JSON.parse(row.params) as PendingAuthorization;
  }

  private token(token: string, kind: "access" | "refresh") {
    return this.db.prepare(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?`).get(hash(token), kind) as
      | { client_id: string; family: string; scopes: string; resource: string | null; expires_at: number; used: number }
      | undefined;
  }

  /** Tokens are only for this server's /mcp endpoint. */
  private checkResource(resource?: URL): void {
    if (!resource) return;
    const want = this.opts.resource.href.replace(/\/$/, "");
    const got = resource.href.replace(/#.*$/, "").replace(/\/$/, "");
    if (got !== want) throw new InvalidTargetError(`This server only issues tokens for ${want}`);
  }

  private cleanup(): void {
    const now = this.now();
    this.db.prepare(`DELETE FROM oauth_pending WHERE expires_at < ?`).run(now);
    this.db.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).run(now);
    this.db.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ?`).run(now);
  }
}
