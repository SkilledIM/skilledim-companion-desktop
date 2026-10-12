# Build

## Frontend only

```bash
npm run build
```

Output: `dist/` (static assets consumed by Tauri).

## Native desktop packages

```bash
npm run tauri:build
```

This runs:

1. `npm run build` (TypeScript + Vite)
2. Rust release compile
3. Platform bundlers (NSIS/MSI on Windows, etc.)

## Windows artifact names

| Item | Value |
|---|---|
| Product | SkilledIM Companion |
| Executable | `SkilledIM.Companion.exe` |
| Identifier | `com.skilledim.companion` |

Typical output locations after a Windows build:

- `src-tauri/target/release/SkilledIM.Companion.exe`
- `src-tauri/target/release/bundle/nsis/`
- `src-tauri/target/release/bundle/msi/`

## Environment for CI builds

Provide the same `VITE_*` variables used in development if origins differ from defaults.

```bash
# example
set VITE_API_BASE_URL=https://api.skilledim.com
set VITE_PORTAL_BASE_URL=https://portal.skilledim.com
set VITE_DEMO_MODE=false
npm run tauri:build
```

Browser login + deep links require a real Tauri build/runtime. Frontend-only `npm run build` validates TypeScript/Vite only.

## Debug vs release

- Dev: `npm run tauri:dev` (Vite HMR + debug logging plugin)
- Release: `npm run tauri:build` (minified frontend, no debug console window on Windows)
