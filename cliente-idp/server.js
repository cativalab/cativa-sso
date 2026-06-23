// IdP OIDC (mock) do cliente — a Cativa federa para ele (fluxo ExternalIdp).
//
// A Cativa, agindo como Relying Party, redireciona o membro para /authorize aqui;
// este IdP "autentica" o usuario de demonstracao, devolve um `code` para o callback
// da Cativa, e no /token emite um id_token RS256 assinado (com email, obrigatorio).
//
// IMPORTANTE: a Cativa em prod busca discovery/jwks/token DESTE servidor pela internet.
// localhost nao serve. Exponha via tunel e ponha a URL em PUBLIC_URL.

import express from "express";
import crypto from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { readFileSync } from "node:fs";

loadDotEnv();
const PORT = parseInt(process.env.PORT || "4010", 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const CLIENT_ID = process.env.CLIENT_ID || "cativa-federated-demo";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "super-secret-demo";
const KID = "cliente-idp-1";

const DEMO = {
  sub: process.env.DEMO_SUB || "user-123",
  email: process.env.DEMO_EMAIL || "demo@cliente.com",
  given_name: process.env.DEMO_GIVEN_NAME || "Demo",
  family_name: process.env.DEMO_FAMILY_NAME || "Cliente",
  picture: process.env.DEMO_PICTURE || undefined,
};
DEMO.name = `${DEMO.given_name} ${DEMO.family_name}`.trim();

// chaves RS256 geradas no boot + cache de authorization codes
let keys = null;       // { privateKey, publicJwk }
const codes = new Map(); // code -> { redirect_uri, createdAt }

const app = express();
app.use(express.urlencoded({ extended: false }));

// --- Discovery ------------------------------------------------------------
app.get("/.well-known/openid-configuration", (_req, res) => {
  res.json({
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/authorize`,
    token_endpoint: `${PUBLIC_URL}/token`,
    userinfo_endpoint: `${PUBLIC_URL}/userinfo`,
    jwks_uri: `${PUBLIC_URL}/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    claims_supported: ["sub", "name", "email", "given_name", "family_name", "picture"],
  });
});

// --- JWKS -----------------------------------------------------------------
app.get("/jwks", (_req, res) => {
  res.json({ keys: [keys.publicJwk] });
});

// --- Authorize: tela de "login" do IdP do cliente -------------------------
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, response_type, scope } = req.query;
  if (client_id !== CLIENT_ID) return res.status(400).send("client_id desconhecido");
  if (!redirect_uri) return res.status(400).send("redirect_uri ausente");
  if (response_type && response_type !== "code") return res.status(400).send("response_type nao suportado");

  const q = new URLSearchParams({
    redirect_uri: String(redirect_uri),
    state: String(state || ""),
    scope: String(scope || ""),
  });
  res.type("html").send(page(`
    <h1>IdP do cliente</h1>
    <p>A Cativa pediu para autenticar um usuario (client_id <code>${esc(client_id)}</code>).</p>
    <p>Logar como:</p>
    <pre>${esc(JSON.stringify(DEMO, null, 2))}</pre>
    <form method="GET" action="/approve">
      ${[...q.entries()].map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}
      <button class="btn" type="submit">Autenticar e voltar para a Cativa &rarr;</button>
    </form>
  `));
});

// --- Approve: emite o code e redireciona pro callback da Cativa -----------
app.get("/approve", (req, res) => {
  const { redirect_uri, state } = req.query;
  const code = b64url(crypto.randomBytes(24));
  codes.set(code, { redirect_uri: String(redirect_uri), createdAt: Date.now() });
  const url = new URL(String(redirect_uri));
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", String(state));
  res.redirect(url.toString());
});

// --- Token: troca code -> id_token RS256 ----------------------------------
app.post("/token", async (req, res) => {
  const { grant_type, code, client_id, client_secret, redirect_uri } = req.body;
  if (grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });
  if (client_id !== CLIENT_ID || client_secret !== CLIENT_SECRET) return res.status(400).json({ error: "invalid_client" });

  const entry = codes.get(code);
  if (!entry) return res.status(400).json({ error: "invalid_grant", error_description: "code invalido" });
  codes.delete(code);
  if (redirect_uri && entry.redirect_uri !== redirect_uri)
    return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri nao confere" });

  const now = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({
    email: DEMO.email,
    email_verified: true,
    name: DEMO.name,
    given_name: DEMO.given_name,
    family_name: DEMO.family_name,
    ...(DEMO.picture ? { picture: DEMO.picture } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(PUBLIC_URL)
    .setSubject(DEMO.sub)
    .setAudience(CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(keys.privateKey);

  res.json({
    access_token: b64url(crypto.randomBytes(24)),
    token_type: "Bearer",
    expires_in: 300,
    id_token: idToken,
    scope: "openid profile email",
  });
});

// --- UserInfo (opcional) --------------------------------------------------
app.get("/userinfo", (_req, res) => {
  res.json({ sub: DEMO.sub, name: DEMO.name, email: DEMO.email, picture: DEMO.picture });
});

// --- boot -----------------------------------------------------------------
(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(publicKey)), use: "sig", alg: "RS256", kid: KID };
  keys = { privateKey, publicJwk };

  app.listen(PORT, () => {
    console.log(`cliente-idp em http://localhost:${PORT}`);
    console.log("PUBLIC_URL  =", PUBLIC_URL);
    if (PUBLIC_URL.includes("localhost")) {
      console.log("\n!! PUBLIC_URL aponta para localhost: a Cativa prod NAO vai alcancar.");
      console.log("   Suba um tunel e ajuste PUBLIC_URL no .env.\n");
    }
    console.log("Registre no admin do tenant um Identity Provider com:");
    console.log("  MetadataUrl =", `${PUBLIC_URL}/.well-known/openid-configuration`);
    console.log("  ClientId    =", CLIENT_ID);
    console.log("  ClientSecret=", CLIENT_SECRET);
    console.log("  Scopes      = openid profile email");
    console.log("  AutoProvision = true (para criar o usuario no 1o login)\n");
  });
})();

// --- util -----------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function page(body) {
  return `<!doctype html><meta charset="utf-8"><title>IdP do cliente</title>
  <style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111}
  pre{background:#f5f5f7;padding:12px;border-radius:8px;overflow:auto;font-size:12px}
  .btn{background:#111;color:#fff;padding:10px 16px;border:0;border-radius:8px;cursor:pointer;font-size:15px}
  code{background:#f0f0f0;padding:1px 5px;border-radius:4px}</style>${body}`;
}
function loadDotEnv() {
  try {
    const txt = readFileSync(new URL("./.env", import.meta.url), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* sem .env */ }
}
