# Architecture

## Overview

SkilledIM Companion is a thin desktop client around the existing SkilledIM HRM HTTP API. Authentication happens in the **system browser**; the desktop shell only receives a JWT callback and talks to documented SkilledIM endpoints afterward.

Browser-wait UX follows native-app practice (RFC 8252 loopback): Companion opens a short-lived `127.0.0.1` watch server; the portal tab heartbeats while open and signals close on `pagehide`. Waiting ends when the tab disconnects — not via a fake countdown. If the portal already has a SkilledIM session, it returns the JWT immediately.

```text
SkilledIM Companion
        |
        | Login on SkilledIM
        v
Default System Browser
        |
        v
SkilledIM Authentication (portal.skilledim.com)
        |
        +-- Existing SkilledIM browser session --> authorize Companion
        |
        +-- No session --> normal SkilledIM login --> authorize Companion
                 |
                 v
          skilledim-companion://auth/callback?token=...&state=...
                 |
                 v
          POST /api/auth/validate-token
                 |
                 v
          OS secure storage + attendance APIs
```

## OpenAPI findings (Authentication)

Inspected: `https://api.skilledim.com/api-docs` (Swagger UI tag **Authentication**).

| Capability | Present? |
|---|---|
| OAuth 2.0 authorize / token | **No** |
| OpenID Connect / PKCE | **No** |
| Device code | **No** |
| `POST /api/auth/signin` (email/password) | Yes — **not used by Companion UI** |
| `POST /api/auth/validate-token?token=` (cross-domain JWT) | Yes — **used** |
| `GET /api/auth/session` | Yes — enrichment / revalidation |
| `POST /api/auth/signout` | Yes |

Because Authorization Code + PKCE is not offered by SkilledIM, Companion implements browser JWT handoff + `validate-token` (the documented cross-domain mechanism). PKCE verifier/challenge validation is intentionally not invented.

### Portal callback contract

Companion opens:

```text
https://portal.skilledim.com/
  ?client_id=skilledim-companion
  &redirect_uri=skilledim-companion://auth/callback
  &response_type=token
  &state=<csrf>
```

(Use portal root `/`, not `/login`. Authenticated sessions treat `/login` as an unknown MainLayout path and show NotFound.)

SkilledIM should redirect to:

```text
skilledim-companion://auth/callback?token=<jwt>&state=<csrf>
```

(`access_token` is also accepted; hash fragments are supported.)

## Frontend modules

| Module | Responsibility |
|---|---|
| `src/main.ts` | Boot |
| `src/attendance.ts` | Dashboard, timer, week history |
| `src/auth.ts` | Browser login orchestration, state, deep-link handling |
| `src/api.ts` | SkilledIM HTTP client (no password sign-in) |
| `src/secureStore.ts` | Tauri invoke wrappers for OS secure storage |
| `src/jwt.ts` | JWT expiry helpers (decode only; authenticity via API) |
| `src/config.ts` | Env-driven settings |

## Rust / shell

| Module | Responsibility |
|---|---|
| `src-tauri/src/secure_store.rs` | OS keyring storage for JWT + pending auth state |
| `src-tauri/src/lib.rs` | Deep link, opener, single-instance, commands |
| `src-tauri/tauri.conf.json` | Product identity, CSP, `skilledim-companion` scheme |

## Attendance

SkilledIM Employee Self Service / Attendance APIs remain the source of truth:

- today's status
- check-in / check-out
- week history

Companion polls cloud status periodically so changes made on the SkilledIM ESS website are eventually reflected. There is no separate local attendance ledger and no “Already Done” bypass.

## Demo mode

`VITE_DEMO_MODE=true` simulates auth + attendance locally and **never** calls production attendance APIs. The UI shows a clear DEMO banner.
