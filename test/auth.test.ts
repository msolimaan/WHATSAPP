import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hostAllowed } from "../src/auth/provider.js";
import { passwordMatches } from "../src/auth/router.js";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { setup } from "./helpers.js";

const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const STATIC = "s".repeat(40);

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

async function app(over: Partial<Config> = {}) {
  const t = await setup({ PUBLIC_BASE_URL: BASE, OWNER_PASSWORD: PASSWORD, MCP_BEARER_TOKEN: STATIC, ...over });
  return { t, http: createApp(t) };
}

function register(http: Awaited<ReturnType<typeof app>>["http"], redirect = CALLBACK, name = "Claude") {
  return request(http).post("/register").send({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
}

/** Walks the whole flow claude.ai uses and returns the tokens. */
async function login(http: Awaited<ReturnType<typeof app>>["http"]) {
  const client = (await register(http).expect(201)).body as { client_id: string };
  const { verifier, challenge } = pkce();
  const page = await request(http)
    .get("/authorize")
    .query({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${BASE}/mcp` })
    .expect(200);
  const pendingId = page.text.match(/name="request" value="([^"]+)"/)![1];
  const back = await request(http).post("/oauth/login").type("form").send({ request: pendingId, password: PASSWORD, decision: "allow" }).expect(302);
  const url = new URL(back.headers.location);
  const tokens = await request(http)
    .post("/token")
    .type("form")
    .send({ grant_type: "authorization_code", code: url.searchParams.get("code"), code_verifier: verifier, client_id: client.client_id, redirect_uri: CALLBACK, resource: `${BASE}/mcp` })
    .expect(200);
  return { client, url, page, pendingId, verifier, tokens: tokens.body as { access_token: string; refresh_token: string; expires_in: number } };
}

const mcp = (http: Awaited<ReturnType<typeof app>>["http"], token?: string) => {
  const r = request(http).post("/mcp").set("Accept", "application/json, text/event-stream");
  return (token ? r.set("Authorization", `Bearer ${token}`) : r).send(init);
};

describe("settings", () => {
  it("needs a public https address for OAuth", () => {
    const base = { WA_API_KEY: "k", WEBHOOK_PATH_SECRET: "a".repeat(24) };
    expect(() => loadConfig({ ...base, OWNER_PASSWORD: PASSWORD })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadConfig({ ...base, OWNER_PASSWORD: PASSWORD, PUBLIC_BASE_URL: "http://example.com" })).toThrow(/https/);
    expect(() => loadConfig({ ...base, OWNER_PASSWORD: "short", PUBLIC_BASE_URL: "https://x.example" })).toThrow(/12 characters/);
    expect(loadConfig({ ...base, OWNER_PASSWORD: PASSWORD, PUBLIC_BASE_URL: "https://wa.example.com" }).OAUTH_ALLOWED_REDIRECT_HOSTS).toEqual(["claude.ai", "claude.com", "localhost", "127.0.0.1"]);
  });

  it("only lets approved hosts receive logins", () => {
    const allowed = ["claude.ai", "claude.com", "localhost", "127.0.0.1"];
    expect(hostAllowed(CALLBACK, allowed)).toBe(true);
    expect(hostAllowed("http://localhost:6274/oauth/callback", allowed)).toBe(true);
    expect(hostAllowed("http://claude.ai/cb", allowed)).toBe(false); // remote must be https
    expect(hostAllowed("https://claude.ai.evil.com/cb", allowed)).toBe(false);
    expect(hostAllowed("https://evilclaude.ai/cb", allowed)).toBe(false);
    expect(hostAllowed("javascript:alert(1)", allowed)).toBe(false);
  });

  it("compares passwords exactly", () => {
    expect(passwordMatches(PASSWORD, PASSWORD)).toBe(true);
    expect(passwordMatches(`${PASSWORD} `, PASSWORD)).toBe(false);
    expect(passwordMatches("", PASSWORD)).toBe(false);
  });
});

describe("OAuth for Claude apps", () => {
  let a: Awaited<ReturnType<typeof app>>;
  beforeEach(async () => {
    a = await app();
  });

  it("tells clients where to log in", async () => {
    const r = await mcp(a.http).expect(401);
    expect(r.headers["www-authenticate"]).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    const prm = await request(a.http).get("/.well-known/oauth-protected-resource/mcp").expect(200);
    expect(prm.body).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [`${BASE}/`] });
    const meta = await request(a.http).get("/.well-known/oauth-authorization-server").expect(200);
    expect(meta.body).toMatchObject({ authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, registration_endpoint: `${BASE}/register`, code_challenge_methods_supported: ["S256"] });
  });

  it("refuses to register apps that would send logins elsewhere", async () => {
    const r = await register(a.http, "https://evil.example.com/callback").expect(400);
    expect(r.body.error_description).toContain("redirect_uri not allowed");
  });

  it("asks for the owner password, then issues tokens that open /mcp", async () => {
    const { page, url, tokens } = await login(a.http);
    expect(page.text).toContain("<strong>Claude</strong> (returning to <strong>claude.ai</strong>)");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["content-security-policy"]).toContain("form-action 'self' https://claude.ai");
    expect(url.origin + url.pathname).toBe(CALLBACK);
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(tokens).toMatchObject({ expires_in: 3600 });
    const ok = await mcp(a.http, tokens.access_token).expect(200);
    expect(ok.body.result.serverInfo.name).toBe("whatsapp-mcp");
  });

  it("stores only hashes of codes and tokens", async () => {
    const { tokens } = await login(a.http);
    const dump = JSON.stringify(a.t.store.db.prepare("SELECT * FROM oauth_tokens").all());
    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token);
  });

  it("rejects a wrong password and keeps the request open for another try", async () => {
    const client = (await register(a.http).expect(201)).body;
    const { challenge } = pkce();
    const page = await request(a.http).get("/authorize").query({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256" });
    const id = page.text.match(/name="request" value="([^"]+)"/)![1];
    const bad = await request(a.http).post("/oauth/login").type("form").send({ request: id, password: "guess", decision: "allow" }).expect(401);
    expect(bad.text).toContain("Wrong password.");
    await request(a.http).post("/oauth/login").type("form").send({ request: id, password: PASSWORD, decision: "allow" }).expect(302);
    // The request is single-use.
    await request(a.http).post("/oauth/login").type("form").send({ request: id, password: PASSWORD, decision: "allow" }).expect(400);
  });

  it("sends the app an access_denied when the owner clicks Deny", async () => {
    const client = (await register(a.http).expect(201)).body;
    const page = await request(a.http).get("/authorize").query({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s1" });
    const id = page.text.match(/name="request" value="([^"]+)"/)![1];
    const r = await request(a.http).post("/oauth/login").type("form").send({ request: id, decision: "deny" }).expect(302);
    expect(r.headers.location).toBe(`${CALLBACK}?error=access_denied&state=s1`);
  });

  it("escapes app names on the login page", async () => {
    const client = (await register(a.http, CALLBACK, '<script>alert("x")</script>').expect(201)).body;
    const page = await request(a.http).get("/authorize").query({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    expect(page.text).not.toContain("<script>");
    expect(page.text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("won't exchange a code twice, or without the right PKCE verifier", async () => {
    const client = (await register(a.http).expect(201)).body;
    const { verifier, challenge } = pkce();
    const page = await request(a.http).get("/authorize").query({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256" });
    const id = page.text.match(/name="request" value="([^"]+)"/)![1];
    const back = await request(a.http).post("/oauth/login").type("form").send({ request: id, password: PASSWORD, decision: "allow" });
    const code = new URL(back.headers.location).searchParams.get("code");
    const ex = (v: string) => request(a.http).post("/token").type("form").send({ grant_type: "authorization_code", code, code_verifier: v, client_id: client.client_id, redirect_uri: CALLBACK });
    await ex(pkce().verifier).expect(400);
    await ex(verifier).expect(200);
    await ex(verifier).expect(400);
  });

  it("refuses tokens meant for another server", async () => {
    const client = (await register(a.http).expect(201)).body;
    const r = await request(a.http).get("/authorize").query({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: "https://other.example.com/mcp" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("error=invalid_target");
  });

  it("refreshes, and ends the whole login if a refresh token is reused", async () => {
    const { client, tokens } = await login(a.http);
    const refresh = (t: string) => request(a.http).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token: t, client_id: client.client_id });
    const next = (await refresh(tokens.refresh_token).expect(200)).body;
    await mcp(a.http, tokens.access_token).expect(401); // the old access token stops working
    await mcp(a.http, next.access_token).expect(200);
    await refresh(tokens.refresh_token).expect(400); // replay of a used refresh token…
    await mcp(a.http, next.access_token).expect(401); // …signs that login out everywhere
    await refresh(next.refresh_token).expect(400);
  });

  it("rejects expired and revoked tokens", async () => {
    const { client, tokens } = await login(a.http);
    a.t.store.db.prepare("UPDATE oauth_tokens SET expires_at = 0 WHERE kind = 'access'").run();
    await mcp(a.http, tokens.access_token).expect(401);
    const fresh = (await request(a.http).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }).expect(200)).body;
    await request(a.http).post("/revoke").type("form").send({ token: fresh.access_token, client_id: client.client_id }).expect(200);
    await mcp(a.http, fresh.access_token).expect(401);
  });

  it("still accepts the static token for Claude Code", async () => {
    await mcp(a.http, STATIC).expect(200);
    await mcp(a.http, `${STATIC}x`).expect(401);
  });

  it("pauses logins after many wrong passwords from anywhere", async () => {
    const client = (await register(a.http).expect(201)).body;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await request(a.http).get("/authorize").query({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256" });
      ids.push(page.text.match(/name="request" value="([^"]+)"/)![1]);
    }
    let last;
    // Different "IPs" so only the global limit applies.
    for (let i = 0; i < 21; i++) {
      last = await request(a.http).post("/oauth/login").set("X-Forwarded-For", `10.0.0.${i}`).type("form").send({ request: ids[i % 3], password: "nope", decision: "allow" });
    }
    expect(last!.status).toBe(429);
    const right = await request(a.http).post("/oauth/login").set("X-Forwarded-For", "10.0.1.1").type("form").send({ request: ids[0], password: PASSWORD, decision: "allow" });
    expect(right.status).toBe(429); // even the right password waits
  });

  it("limits password guesses per address", async () => {
    const client = (await register(a.http).expect(201)).body;
    const page = await request(a.http).get("/authorize").query({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const id = page.text.match(/name="request" value="([^"]+)"/)![1];
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await request(a.http).post("/oauth/login").set("X-Forwarded-For", "203.0.113.9").type("form").send({ request: id, password: "nope", decision: "allow" })).status);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe("without OAuth", () => {
  it("works with only the static token, and is closed when nothing is configured", async () => {
    const onlyStatic = await setup({ MCP_BEARER_TOKEN: STATIC });
    await mcp(createApp(onlyStatic), STATIC).expect(200);
    await request(createApp(onlyStatic)).get("/.well-known/oauth-authorization-server").expect(404);
    const none = await setup();
    await mcp(createApp(none), STATIC).expect(503);
  });

  it("sends basic security headers everywhere", async () => {
    const r = await request(createApp(await setup())).get("/health").expect(200);
    expect(r.headers).toMatchObject({ "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });
});
