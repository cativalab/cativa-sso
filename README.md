# SSO Demos — Cativa

Dois apps Node + Express que exercitam ponta-a-ponta os dois sentidos de SSO da Cativa contra **produção** (`apis.cativalab.digital`).

| Pasta | Papel | Fluxo no backend | Quem é o IdP |
|---|---|---|---|
| [`login-com-cativa/`](login-com-cativa) | Relying Party ("Login com a Cativa") | `CativaIdp` (OIDC auth-code + PKCE) | **A Cativa** |
| [`cliente-idp/`](cliente-idp) | IdP OIDC do cliente (mock) | `ExternalIdp` (login federado) | **O cliente** (este app) |

Base de URL OIDC da Cativa em prod:

```
https://apis.cativalab.digital/tenant/api/v2/sso/{customer}/...
```

`{customer}` = slug do tenant (ex.: `minha-comunidade`). Os endpoints relevantes:

- `.../sso/{customer}/.well-known/openid-configuration` — discovery
- `.../sso/{customer}/jwks` — chave pública ES256
- `.../sso/{customer}/authorize` — autorização (faz trampolim pro frontend do tenant)
- `.../sso/{customer}/token` — troca de code (PKCE + client_secret_post)
- `.../sso/{customer}/userinfo` — claims do usuário
- `.../sso/{customer}/register` — Dynamic Client Registration (RFC 7591, **aberto**)
- `.../sso/external/{customer}/{slug}/authorize` — inicia login federado (lado `cliente-idp`)
- `.../sso/external/{customer}/callback` — callback do federado

## Pré-requisitos

- Node 20+ (usa `fetch` global e `crypto.webcrypto`).
- Um tenant/customer slug válido em prod.
- Para `cliente-idp`: a Cativa (prod) precisa **alcançar seu IdP pela internet**. localhost não serve. Use um túnel (`cloudflared tunnel --url http://localhost:4010` ou `ngrok http 4010`) e ponha a URL pública em `PUBLIC_URL`. Depois registre o provider no admin do tenant.

## Qual é qual, em uma frase

- **login-com-cativa**: você tem um app de terceiro e quer um botão "Entrar com a Cativa". A Cativa autentica o usuário e te devolve tokens.
- **cliente-idp**: o cliente já tem o IdP dele (Keycloak/Auth0/Azure AD/etc). Os membros da comunidade Cativa logam pelo IdP do cliente. Este app simula esse IdP.

Cada pasta tem seu próprio README com o passo-a-passo.
