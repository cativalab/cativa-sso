// Relying Party OIDC — "Login com a Cativa" (Cativa como IdP).
// Fluxo: authorization-code + PKCE (S256), client_secret_post no /token.
//
// Boot:
//  1. Le discovery em {CATIVA_API_BASE}/sso/{CUSTOMER}/.well-known/openid-configuration
//  2. Se CLIENT_ID vazio, faz Dynamic Client Registration (RFC 7591) e imprime as credenciais.
//
// Sem dependencia de sessao/cookie: o estado do fluxo (state -> code_verifier) fica
// num Map em memoria, chaveado pelo `state` que volta no callback.

import express from "express";
import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";
import { readFileSync } from "node:fs";

// --- config ---------------------------------------------------------------
loadDotEnv();
const CATIVA_API_BASE = (process.env.CATIVA_API_BASE || "https://apis.cativalab.digital/tenant/api/v2").replace(/\/$/, "");
const CUSTOMER = process.env.CUSTOMER || "makersday";
const PORT = parseInt(process.env.PORT || "4000", 10);
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const SCOPE = process.env.SCOPE || "openid profile email";
let CLIENT_ID = process.env.CLIENT_ID || "";
let CLIENT_SECRET = process.env.CLIENT_SECRET || "";

const SSO_BASE = `${CATIVA_API_BASE}/sso/${CUSTOMER}`;

// state -> { codeVerifier, createdAt }
const pending = new Map();
let discovery = null; // cache do discovery document

// --- helpers --------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pkcePair() {
  const codeVerifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, challenge };
}

async function loadDiscovery() {
  const res = await fetch(`${SSO_BASE}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Discovery falhou: ${res.status} ${await res.text()}`);
  discovery = await res.json();
  return discovery;
}

async function dynamicRegister() {
  const res = await fetch(`${SSO_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: "login-com-cativa (demo)",
      scope: SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`Dynamic Client Registration falhou: ${res.status} ${await res.text()}`);
  const reg = await res.json();
  CLIENT_ID = reg.client_id;
  CLIENT_SECRET = reg.client_secret;
  console.log("\n=== Dynamic Client Registration OK ===");
  console.log("CLIENT_ID    =", CLIENT_ID);
  console.log("CLIENT_SECRET=", CLIENT_SECRET);
  console.log("Fixe esses valores no .env para reutilizar o mesmo client.\n");
}

// --- app ------------------------------------------------------------------
const app = express();

app.get("/", (_req, res) => {
  res.type("html").send(page(`
    <h1>Login com a Cativa</h1>
    <p>Relying Party OIDC apontando para <code>${SSO_BASE}</code></p>
    <p>client_id: <code>${CLIENT_ID || "(registrando...)"}</code></p>
    <p><a class="btn" href="/login">Entrar com a Cativa &rarr;</a></p>
  `));
});

app.get("/login", async (req, res) => {
  try {
    if (!discovery) await loadDiscovery();
    const { codeVerifier, challenge } = pkcePair();
    const state = b64url(crypto.randomBytes(16));
    pending.set(state, { codeVerifier, createdAt: Date.now() });

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  } catch (err) {
    res.status(500).type("html").send(page(`<h1>Erro no /login</h1><pre>${esc(err.message)}</pre>`));
  }
});

app.get("/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) throw new Error(`IdP retornou erro: ${error} ${error_description || ""}`);
    if (!code || !state) throw new Error("code ou state ausente no callback");

    const entry = pending.get(state);
    if (!entry) throw new Error("state desconhecido/expirado (CSRF guard)");
    pending.delete(state);

    // troca code -> tokens
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: entry.codeVerifier,
    });
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(`Token endpoint ${tokenRes.status}: ${JSON.stringify(tokens)}`);

    // verifica a assinatura do id_token via JWKS da Cativa (ES256)
    let idTokenClaims = null;
    let idTokenVerified = false;
    if (tokens.id_token) {
      try {
        const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
        const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: discovery.issuer });
        idTokenClaims = payload;
        idTokenVerified = true;
      } catch (e) {
        idTokenClaims = safeDecode(tokens.id_token);
        idTokenClaims._verify_error = e.message;
      }
    }

    // chama userinfo com o access_token
    let userinfo = null;
    try {
      const uiRes = await fetch(discovery.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      userinfo = uiRes.ok ? await uiRes.json() : { _status: uiRes.status, _body: await uiRes.text() };
    } catch (e) {
      userinfo = { _error: e.message };
    }

    res.type("html").send(page(`
      <h1>Logado com a Cativa &check;</h1>
      <h3>userinfo</h3><pre>${esc(JSON.stringify(userinfo, null, 2))}</pre>
      <h3>id_token (assinatura ${idTokenVerified ? "<b>verificada</b> via JWKS" : "<b>NAO verificada</b>"})</h3>
      <pre>${esc(JSON.stringify(idTokenClaims, null, 2))}</pre>
      <h3>access_token (ES256, aud=cativa-api)</h3>
      <pre>${esc(JSON.stringify(safeDecode(tokens.access_token), null, 2))}</pre>
      <h3>resposta crua do /token</h3>
      <pre>${esc(JSON.stringify({ ...tokens, access_token: "<<jwt>>", id_token: "<<jwt>>" }, null, 2))}</pre>
      <p><a class="btn" href="/">Voltar</a></p>
    `));
  } catch (err) {
    res.status(500).type("html").send(page(`<h1>Erro no /callback</h1><pre>${esc(err.message)}</pre><p><a href="/">voltar</a></p>`));
  }
});

// --- boot -----------------------------------------------------------------
(async () => {
  try {
    await loadDiscovery();
    console.log("Discovery OK. issuer =", discovery.issuer);
    if (!CLIENT_ID || !CLIENT_SECRET) await dynamicRegister();
  } catch (err) {
    console.error("Falha no boot:", err.message);
    console.error("Confira CATIVA_API_BASE e CUSTOMER no .env.");
  }
  app.listen(PORT, () => console.log(`login-com-cativa em http://localhost:${PORT}`));
})();

// --- util ------------------------------------------------------------------
function safeDecode(jwt) {
  try { return decodeJwt(jwt); } catch { return null; }
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function page(body) {
  return `<!doctype html><meta charset="utf-8"><title>Login com a Cativa</title>
  <style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#111}
  pre{background:#f5f5f7;padding:12px;border-radius:8px;overflow:auto;font-size:12px}
  .btn{display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none}
  code{background:#f0f0f0;padding:1px 5px;border-radius:4px}</style>${body}`;
}
// .env loader minimo (sem dependencia)
function loadDotEnv() {
  try {
    const txt = readFileSync(new URL("./.env", import.meta.url), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* sem .env, usa defaults/ambiente */ }
}
