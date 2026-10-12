# Security

## Authentication model

Companion does **not** collect email, username, or password.

Users click **Login on SkilledIM**, authenticate in the system browser, and return via:

`skilledim-companion://auth/callback`

Companion validates:

- callback protocol / path
- CSRF `state` (bound to a pending login in secure storage, 15-minute TTL)
- JWT `exp` when present
- token authenticity via existing `POST /api/auth/validate-token`

Companion does **not** read or reuse browser cookies.

## Token storage

Access tokens are stored only through the OS credential store via the Rust `keyring` crate:

- Windows Credential Manager
- macOS Keychain
- Linux Secret Service (when available)

Tokens are **never** stored in:

- `localStorage`
- plain JSON config files
- `.env`
- SQLite
- application logs

In-memory token copies exist only for the running process after a successful restore/login.

## Trust boundary

- Bundled UI assets only (`dist/`)
- Network: configured API + portal origins
- CSP in `src-tauri/tauri.conf.json`
- Opener plugin allowlist limited to SkilledIM portal/API HTTPS URLs
- Deep-link scheme: `skilledim-companion`

## Capabilities

`src-tauri/capabilities/default.json` grants least privilege for core events, deep-link, and opener. Do not add shell/filesystem permissions without review.

## Reporting

Report security issues privately to the SkilledIM team (`support@skilledim.com`).
