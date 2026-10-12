# SkilledIM Companion

Desktop attendance companion for **SkilledIM HRM**, built with **Vite**, **TypeScript**, and **Tauri 2**.

Agents authorize through SkilledIM in the **system browser** (never by typing a password into Companion), then check in / check out against the existing SkilledIM cloud APIs.

| | |
|---|---|
| Product name | SkilledIM Companion |
| Repository | `skilledim-companion-desktop` |
| Tauri identifier | `com.skilledim.companion` |
| Windows executable | `SkilledIM.Companion.exe` |
| Auth callback | `skilledim-companion://auth/callback` |

## Features

- **Login on SkilledIM** — browser-based authorization (no email/password fields in Companion)
- Deep-link callback + CSRF `state` validation
- JWT validation via existing `POST /api/auth/validate-token`
- Tokens stored in OS secure storage (Windows Credential Manager / Keychain / libsecret)
- Live attendance status with running work timer
- Check-in / check-out for today (SkilledIM APIs are source of truth)
- One-week attendance history + periodic cloud refresh
- Optional demo mode (`VITE_DEMO_MODE=true`) that never calls production attendance APIs

## Authentication (important)

The published SkilledIM OpenAPI (`https://api.skilledim.com/api-docs`) does **not** expose OAuth 2.0 / OpenID Connect Authorization Code + PKCE.

Companion therefore uses the safest browser handoff supported by the existing Authentication API:

1. User clicks **Login on SkilledIM**
2. System browser opens `portal.skilledim.com`
3. User signs in (or reuses an existing SkilledIM browser session)
4. SkilledIM redirects to `skilledim-companion://auth/callback` with a JWT + `state`
5. Companion validates `state` / expiry and calls `POST /api/auth/validate-token`

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [SECURITY.md](./SECURITY.md).

## Tech stack

- Vite + TypeScript (vanilla UI)
- Tauri 2 (Rust shell, deep link, opener, secure storage)

## Quick start

```bash
npm install
cp .env.example .env   # optional
npm run tauri:dev
```

Demo UI without production APIs:

```env
VITE_DEMO_MODE=true
```

## Build

```bash
npm run typecheck
npm run build
npm run tauri:build   # requires Rust + Tauri prerequisites
```

## Documentation

| Doc | Purpose |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design and auth flow |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Local setup |
| [BUILD.md](./BUILD.md) | Production builds |
| [RELEASE.md](./RELEASE.md) | Release checklist |
| [SECURITY.md](./SECURITY.md) | Token handling and CSP |

## License

MIT © SkilledIM
