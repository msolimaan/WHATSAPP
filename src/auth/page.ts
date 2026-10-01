import type { Response } from "express";
import type { PendingAuthorization } from "./provider.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Security headers for the login page: no framing, no outside resources, forms only to us and the app. */
function headers(res: Response, redirectUri?: string): void {
  let formAction = "'self'";
  // Browsers apply form-action to the redirect after submitting, so the app's origin must be allowed.
  if (redirectUri) formAction += ` ${new URL(redirectUri).origin}`;
  res.set({
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
}

export function renderLogin(
  res: Response,
  v: { pendingId: string; pending: PendingAuthorization; error?: string; status?: number },
): void {
  headers(res, v.pending.redirectUri);
  const host = new URL(v.pending.redirectUri).host;
  res
    .status(v.status ?? 200)
    .type("html")
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to WhatsApp</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f5; --card:#fff; --ink:#1d2321; --muted:#5d6764; --accent:#1f7a52; --err:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121514; --card:#1c201f; --ink:#e8ecea; --muted:#9aa5a1; --accent:#4cc38a; --err:#ff8a80; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, sans-serif; }
  main { width:min(420px, calc(100% - 32px)); background:var(--card); border-radius:16px; padding:28px; box-shadow:0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size:1.25rem; margin:0 0 8px; } p { color:var(--muted); margin:0 0 16px; }
  strong { color:var(--ink); } label { display:block; font-weight:600; margin-bottom:6px; }
  input { width:100%; box-sizing:border-box; padding:12px; border-radius:10px; border:1px solid var(--muted); background:transparent; color:var(--ink); font:inherit; }
  .row { display:flex; gap:12px; margin-top:16px; } button { flex:1; padding:12px; border-radius:10px; border:0; font:inherit; font-weight:600; cursor:pointer; }
  .ok { background:var(--accent); color:#fff; } .no { background:transparent; color:var(--muted); border:1px solid var(--muted); }
  .err { color:var(--err); font-weight:600; }
</style></head>
<body><main>
  <h1>Allow access to your WhatsApp?</h1>
  <p><strong>${esc(v.pending.clientName)}</strong> (returning to <strong>${esc(host)}</strong>) wants to read and send WhatsApp messages and update your Trello CRM.</p>
  ${v.error ? `<p class="err" role="alert">${esc(v.error)}</p>` : ""}
  <form method="post" action="/oauth/login">
    <input type="hidden" name="request" value="${esc(v.pendingId)}">
    <label for="password">Owner password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <div class="row">
      <button class="no" type="submit" name="decision" value="deny" formnovalidate>Deny</button>
      <button class="ok" type="submit" name="decision" value="allow">Allow</button>
    </div>
  </form>
</main></body></html>`);
}

export function renderMessage(res: Response, status: number, title: string, body: string): void {
  headers(res);
  res
    .status(status)
    .type("html")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(body)}</p></body></html>`);
}
