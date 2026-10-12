/**
 * Browser-based SkilledIM authorization for Companion.
 *
 * OpenAPI finding (https://api.skilledim.com/api-docs):
 * - No OAuth 2.0 / OIDC / PKCE / authorization_code endpoints exist.
 * - Documented auth is JWT via /api/auth/signin (password — NOT used by Companion UI)
 *   and cross-domain POST /api/auth/validate-token?token=...
 *
 * Companion therefore uses the safest supported browser handoff:
 * 1) open SkilledIM portal in the system browser with state + redirect_uri
 * 2) receive JWT on skilledim-companion://auth/callback
 * 3) validate state + token expiry
 * 4) call existing validate-token
 * 5) store JWT in OS secure storage (never localStorage)
 */

import { listen } from '@tauri-apps/api/event';
import { getCurrent as getCurrentDeepLinkUrls, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import { api, type UserSession } from './api';
import {
  APP_NAME,
  AUTH_CALLBACK_URI,
  AUTH_STATE_TTL_MS,
  DEMO_MODE,
  PORTAL_BASE_URL,
} from './config';
import { isJwtExpired, jwtExpiresAt } from './jwt';
import {
  clearPendingAuth,
  isTauriRuntime,
  loadPendingAuth,
  storePendingAuth,
  storeProfileJson,
} from './secureStore';

export type AuthStatus =
  | 'signed_out'
  | 'waiting_for_browser'
  | 'authenticated';

export interface AuthListener {
  (session: UserSession | null, status: AuthStatus, message?: string): void;
}

function randomUrlSafe(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let bin = '';
  arr.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildAuthorizeUrl(state: string): string {
  const url = new URL(`${PORTAL_BASE_URL}/login`);
  url.searchParams.set('client_id', 'skilledim-companion');
  url.searchParams.set('client', 'skilledim-companion');
  url.searchParams.set('redirect_uri', AUTH_CALLBACK_URI);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('state', state);
  url.searchParams.set('source', APP_NAME);
  return url.toString();
}

function parseCallbackUrl(raw: string): { token: string | null; state: string | null; error: string | null } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { token: null, state: null, error: 'Malformed callback URL' };
  }

  if (url.protocol !== 'skilledim-companion:') {
    return { token: null, state: null, error: 'Unexpected callback protocol' };
  }

  const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  const token =
    url.searchParams.get('token') ||
    url.searchParams.get('access_token') ||
    hashParams.get('token') ||
    hashParams.get('access_token');
  const state = url.searchParams.get('state') || hashParams.get('state');
  const error =
    url.searchParams.get('error') ||
    url.searchParams.get('error_description') ||
    hashParams.get('error') ||
    hashParams.get('error_description');

  return { token, state, error };
}

class BrowserAuthService {
  private listeners = new Set<AuthListener>();
  private status: AuthStatus = 'signed_out';
  private session: UserSession | null = null;
  private unlisteners: Array<() => void> = [];
  private handling = false;

  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener);
    listener(this.session, this.status);
    return () => this.listeners.delete(listener);
  }

  getSession(): UserSession | null {
    return this.session;
  }

  getStatus(): AuthStatus {
    return this.status;
  }

  private emit(message?: string) {
    for (const listener of this.listeners) {
      listener(this.session, this.status, message);
    }
  }

  async init(): Promise<void> {
    // Purge legacy insecure storage from earlier builds.
    try {
      localStorage.removeItem('skilledim_token');
      localStorage.removeItem('skilledim_user_session');
      localStorage.removeItem('skilledim_session');
      localStorage.removeItem('authToken');
    } catch {
      /* ignore */
    }

    if (DEMO_MODE) {
      return;
    }

    await this.bindDeepLinks();

    const restored = await api.restoreSession();
    if (restored) {
      this.session = {
        ...restored,
        expiresAt: jwtExpiresAt(restored.token)?.toISOString() ?? null,
      };
      this.status = 'authenticated';
      await storeProfileJson(JSON.stringify({
        userId: this.session.userId,
        employeeId: this.session.employeeId,
        organizationId: this.session.organizationId,
        email: this.session.email,
        name: this.session.name,
        role: this.session.role,
        companyName: this.session.companyName,
      }));
      this.emit();
    }
  }

  private async bindDeepLinks(): Promise<void> {
    if (!isTauriRuntime()) return;

    const handleUrls = async (urls: string[]) => {
      for (const url of urls) {
        if (url.startsWith('skilledim-companion://')) {
          await this.handleCallbackUrl(url);
        }
      }
    };

    try {
      const current = await getCurrentDeepLinkUrls();
      if (current?.length) await handleUrls(current);
    } catch (e) {
      console.warn('deep-link getCurrent failed', e);
    }

    try {
      const unlisten = await onOpenUrl((urls) => {
        void handleUrls(urls);
      });
      this.unlisteners.push(unlisten);
    } catch (e) {
      console.warn('deep-link onOpenUrl failed', e);
    }

    try {
      const unlisten = await listen<string>('companion-auth-callback', (event) => {
        void this.handleCallbackUrl(event.payload);
      });
      this.unlisteners.push(unlisten);
    } catch (e) {
      console.warn('companion-auth-callback listen failed', e);
    }
  }

  async startBrowserLogin(): Promise<void> {
    if (DEMO_MODE) {
      this.session = {
        token: 'demo',
        userId: 1,
        employeeId: 1,
        organizationId: 1,
        email: 'demo@skilledim.local',
        name: 'Demo Agent',
        role: 'Agent',
        companyName: 'SkilledIM Technologies (Demo)',
        expiresAt: null,
      };
      api.setMemoryToken('demo');
      this.status = 'authenticated';
      this.emit('Demo mode — signed in locally (no production API calls).');
      return;
    }

    if (!isTauriRuntime()) {
      throw new Error(
        'Browser sign-in requires the SkilledIM Companion desktop app (Tauri). Use npm run tauri:dev.'
      );
    }

    const state = randomUrlSafe(32);
    await storePendingAuth({ state, createdAt: Date.now() });
    this.status = 'waiting_for_browser';
    this.emit('Complete sign-in in your browser, then authorize Companion.');

    const authorizeUrl = buildAuthorizeUrl(state);
    await openUrl(authorizeUrl);
  }

  async cancelBrowserLogin(): Promise<void> {
    await clearPendingAuth();
    if (this.status === 'waiting_for_browser') {
      this.status = 'signed_out';
      this.emit('Sign-in cancelled.');
    }
  }

  async handleCallbackUrl(raw: string): Promise<void> {
    if (this.handling) return;
    this.handling = true;
    try {
      const parsed = parseCallbackUrl(raw);
      if (parsed.error) {
        this.status = 'signed_out';
        this.emit(parsed.error);
        await clearPendingAuth();
        return;
      }
      if (!parsed.token) {
        this.status = 'signed_out';
        this.emit('Authorization callback did not include a token.');
        await clearPendingAuth();
        return;
      }
      if (!parsed.state) {
        this.status = 'signed_out';
        this.emit('Authorization callback missing state.');
        await clearPendingAuth();
        return;
      }

      const pending = await loadPendingAuth();
      if (!pending) {
        this.status = 'signed_out';
        this.emit('No pending login. Start Login on SkilledIM again.');
        return;
      }
      if (pending.state !== parsed.state) {
        this.status = 'signed_out';
        this.emit('Invalid login state. Possible CSRF — please try again.');
        await clearPendingAuth();
        return;
      }
      if (Date.now() - pending.createdAt > AUTH_STATE_TTL_MS) {
        this.status = 'signed_out';
        this.emit('Login timed out. Please try again.');
        await clearPendingAuth();
        return;
      }
      if (isJwtExpired(parsed.token)) {
        this.status = 'signed_out';
        this.emit('Received an expired token. Please try again.');
        await clearPendingAuth();
        return;
      }

      const session = await api.establishSessionFromToken(parsed.token);
      this.session = {
        ...session,
        expiresAt: jwtExpiresAt(parsed.token)?.toISOString() ?? null,
      };
      await storeProfileJson(JSON.stringify({
        userId: session.userId,
        employeeId: session.employeeId,
        organizationId: session.organizationId,
        email: session.email,
        name: session.name,
        role: session.role,
        companyName: session.companyName,
      }));
      await clearPendingAuth();
      this.status = 'authenticated';
      this.emit('Signed in through SkilledIM.');
    } catch (err) {
      this.status = 'signed_out';
      this.emit(err instanceof Error ? err.message : 'Authorization failed');
      await clearPendingAuth();
    } finally {
      this.handling = false;
    }
  }

  async signOut(): Promise<void> {
    await api.signOut();
    this.session = null;
    this.status = 'signed_out';
    this.emit('Signed out.');
  }

  dispose(): void {
    for (const un of this.unlisteners) un();
    this.unlisteners = [];
    this.listeners.clear();
  }
}

export const browserAuth = new BrowserAuthService();
