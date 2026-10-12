/** Runtime configuration for SkilledIM Companion */

export const APP_NAME = 'SkilledIM Companion';
export const APP_VERSION = '0.1.0';

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ||
  'https://api.skilledim.com';

export const PORTAL_BASE_URL =
  (import.meta.env.VITE_PORTAL_BASE_URL as string | undefined)?.replace(/\/$/, '') ||
  'https://portal.skilledim.com';

/** Deep-link callback registered with the OS / Tauri deep-link plugin. */
export const AUTH_CALLBACK_URI = 'skilledim-companion://auth/callback';

/**
 * When true, auth/attendance are simulated locally and never call production
 * SkilledIM attendance APIs.
 */
export const DEMO_MODE =
  String(import.meta.env.VITE_DEMO_MODE || '').toLowerCase() === 'true';

export const WORK_DAY_SECONDS = 8 * 3600;

/** Pending browser-auth state older than this is rejected. */
export const AUTH_STATE_TTL_MS = 15 * 60 * 1000;
