# Development

## Prerequisites

- Node.js 20+ and npm
- Rust toolchain (stable) for `tauri:dev` / `tauri:build`
- Tauri platform prerequisites ([docs](https://v2.tauri.app/start/prerequisites/))
  - Windows: MSVC Build Tools + WebView2

## Install

```bash
npm install
cp .env.example .env
```

## Run

Desktop (required for real browser login + deep links):

```bash
npm run tauri:dev
```

Frontend-only Vite preview (cannot complete deep-link auth):

```bash
npm run dev
```

Typecheck / build:

```bash
npm run typecheck
npm run build
```

## Demo mode

```env
VITE_DEMO_MODE=true
```

- **Login on SkilledIM** signs in locally
- Attendance actions stay local
- Production attendance APIs are never called
- UI shows a DEMO banner

## Browser auth testing (non-demo)

1. Start `npm run tauri:dev`
2. Click **Login on SkilledIM** (opens portal)
3. After portal authorizes Companion, it must redirect to:

```text
skilledim-companion://auth/callback?token=<jwt>&state=<state-from-step-2>
```

On Windows you can also simulate the callback:

```bat
start skilledim-companion://auth/callback?token=YOUR_JWT&state=YOUR_STATE
```

(`state` must match the pending login started by the button.)

## Notes

- Companion never shows email/password inputs.
- Passwords must only be entered on SkilledIM in the system browser.
- Frontend stack is Vite + TypeScript (vanilla). There is no React dependency in this repo.
