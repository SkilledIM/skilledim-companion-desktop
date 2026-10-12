/**
 * Browser-based SkilledIM authorization for Companion.
 *
 * Best-practice native handoff (no invented OAuth/PKCE — SkilledIM OpenAPI has none):
 * 1) Start a loopback watch server (RFC 8252–style) for tab liveness
 * 2) Open the system browser to the SkilledIM portal with state + redirect_uri + watch_uri
 * 3) Portal heartbeats while the tab is open; pagehide signals close
 * 4) If the browser already has a SkilledIM session, portal returns immediately via deep link
 * 5) Validate state/expiry, POST /api/auth/validate-token, store JWT in OS keyring
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrent as getCurrentDeepLinkUrls, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import { api, type UserSession } from './api';
import {
  APP_NAME,
  AUTH_CALLBACK_URI,
  AUTH_HEARTBEAT_STALE_MS,
  AUTH_STATE_TTL_MS,
  AUTH_WAIT_FALLBACK_MS,
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

/** UI phase while waiting — driven by tab monitoring, not a fake countdown. */
export type AuthWaitPhase = 'opening' | 'connected' | 'idle';

export interface AuthListener {
  (session: UserSession | null, status: AuthStatus, message?: string): void;
}

interface AuthWatchStartResult {
  port: number;
  watchBaseUrl: string;
}

interface AuthWatchStatus {
  active: boolean;
  port: number;
  lastHeartbeatMs: number;
  sawHeartbeat: boolean;
  closed: boolean;
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

async function assertPortalReachable(portalBase: string): Promise<void> {
  const probe = portalBase.replace(/\/$/, '') + '/';
  try {
    await fetch(probe, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
  } catch {
    throw new Error(
      `SkilledIM portal is not reachable at ${portalBase}. ` +
        (portalBase.includes('localhost')
          ? 'Start the portal locally (e.g. npx vite --port 5174) or set VITE_PORTAL_BASE_URL.'
          : 'Check your network and try again.')
    );
  }
}

function buildAuthorizeUrl(state: string, watchBaseUrl: string | null): string {
  const url = new URL(`${PORTAL_BASE_URL}/`);
  url.searchParams.set('client_id', 'skilledim-companion');
  url.searchParams.set('client', 'skilledim-companion');
  url.searchParams.set('redirect_uri', AUTH_CALLBACK_URI);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('state', state);
  url.searchParams.set('source', APP_NAME);
  if (watchBaseUrl) {
    url.searchParams.set('watch_uri', watchBaseUrl);
  }
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
  private waitPollId: ReturnType<typeof setInterval> | null = null;
  private waitStartedAt: number | null = null;
  private waitPhase: AuthWaitPhase = 'idle';
  private sawBrowserHeartbeat = false;
  /** In-memory pending login (survives race where tab-close clears keyring pending early). */
  private pendingState: string | null = null;
  private pendingCreatedAt: number | null = null;
  private tabCloseGraceId: ReturnType<typeof setTimeout> | null = null;
  /** Grace after tab disconnect so loopback /callback can still complete the login. */
  private static readonly TAB_CLOSE_CALLBACK_GRACE_MS = 2500;

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

  getWaitPhase(): AuthWaitPhase {
    return this.status === 'waiting_for_browser' ? this.waitPhase : 'idle';
  }

  private emit(message?: string) {
    for (const listener of this.listeners) {
      listener(this.session, this.status, message);
    }
  }

  private waitingMessage(): string {
    if (this.waitPhase === 'connected') {
      return 'Browser connected. Finish sign-in in the SkilledIM tab (already signed in returns automatically).';
    }
    return 'Waiting for the SkilledIM browser tab…';
  }

  private async stopAuthWatch(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
      await invoke('auth_watch_stop');
    } catch (e) {
      console.warn('auth_watch_stop failed', e);
    }
  }

  private clearWaitTimersOnly(): void {
    if (this.waitPollId != null) {
      clearInterval(this.waitPollId);
      this.waitPollId = null;
    }
    if (this.tabCloseGraceId != null) {
      clearTimeout(this.tabCloseGraceId);
      this.tabCloseGraceId = null;
    }
  }

  private clearWaitWatchers(): void {
    this.clearWaitTimersOnly();
    this.waitStartedAt = null;
    this.waitPhase = 'idle';
    this.sawBrowserHeartbeat = false;
    void this.stopAuthWatch();
  }

  private clearPendingMemory(): void {
    this.pendingState = null;
    this.pendingCreatedAt = null;
  }

  /** Poll loop only — does not tear down the loopback watch server. */
  private startWaitMonitoring(): void {
    this.clearWaitTimersOnly();
    this.waitStartedAt = Date.now();
    this.waitPhase = 'opening';
    this.sawBrowserHeartbeat = false;

    this.waitPollId = setInterval(() => {
      void this.pollWatchStatus();
    }, 1000);
  }

  private async pollWatchStatus(): Promise<void> {
    if (this.status !== 'waiting_for_browser' || this.waitStartedAt == null) {
      this.clearWaitWatchers();
      return;
    }

    const elapsed = Date.now() - this.waitStartedAt;

    try {
      const status = await invoke<AuthWatchStatus>('auth_watch_status');
      if (status.closed) {
        this.scheduleEndWaitBecauseTabClosed();
        return;
      }
      if (status.sawHeartbeat) {
        this.sawBrowserHeartbeat = true;
        if (this.waitPhase !== 'connected') {
          this.waitPhase = 'connected';
          this.emit(this.waitingMessage());
        }
        const age = status.lastHeartbeatMs
          ? Date.now() - status.lastHeartbeatMs
          : AUTH_HEARTBEAT_STALE_MS + 1;
        if (age > AUTH_HEARTBEAT_STALE_MS) {
          // Heartbeats stop during successful handoff navigation — wait for callback first.
          this.scheduleEndWaitBecauseTabClosed();
          return;
        }
      }
    } catch {
      /* status invoke may fail if watch already stopped */
    }

    // Absolute safety net only — no second-by-second countdown UX.
    if (elapsed > AUTH_WAIT_FALLBACK_MS) {
      await this.endWaitBecauseTimeout();
    }
  }

  private scheduleEndWaitBecauseTabClosed(): void {
    if (this.status !== 'waiting_for_browser' || this.handling) return;
    if (this.tabCloseGraceId != null) return;
    this.tabCloseGraceId = setTimeout(() => {
      this.tabCloseGraceId = null;
      void this.endWaitBecauseTabClosed();
    }, BrowserAuthService.TAB_CLOSE_CALLBACK_GRACE_MS);
  }

  private async endWaitBecauseTabClosed(): Promise<void> {
    if (this.status !== 'waiting_for_browser' || this.handling) return;
    this.clearWaitWatchers();
    this.clearPendingMemory();
    await clearPendingAuth();
    this.status = 'signed_out';
    this.emit('Browser tab closed or left the authorize page. Try again when ready.');
  }

  private async endWaitBecauseTimeout(): Promise<void> {
    if (this.status !== 'waiting_for_browser' || this.handling) return;
    this.clearWaitWatchers();
    this.clearPendingMemory();
    await clearPendingAuth();
    this.status = 'signed_out';
    this.emit(
      this.sawBrowserHeartbeat
        ? 'Sign-in timed out. Try again.'
        : 'No response from the browser tab. Try again, or use Cancel.'
    );
  }

  async init(): Promise<void> {
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

    try {
      const unlisten = await listen('companion-auth-tab-heartbeat', () => {
        if (this.status !== 'waiting_for_browser') return;
        this.sawBrowserHeartbeat = true;
        if (this.waitPhase !== 'connected') {
          this.waitPhase = 'connected';
          this.emit(this.waitingMessage());
        }
      });
      this.unlisteners.push(unlisten);
    } catch (e) {
      console.warn('companion-auth-tab-heartbeat listen failed', e);
    }

    try {
      const unlisten = await listen('companion-auth-tab-closed', () => {
        this.scheduleEndWaitBecauseTabClosed();
      });
      this.unlisteners.push(unlisten);
    } catch (e) {
      console.warn('companion-auth-tab-closed listen failed', e);
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
    let watchBaseUrl: string | null = null;
    try {
      const watch = await invoke<AuthWatchStartResult>('auth_watch_start', { state });
      watchBaseUrl = watch.watchBaseUrl;
    } catch (e) {
      console.warn('auth_watch_start failed; continuing without tab monitor', e);
    }

    const createdAt = Date.now();
    this.pendingState = state;
    this.pendingCreatedAt = createdAt;
    await storePendingAuth({ state, createdAt });
    this.status = 'waiting_for_browser';
    this.startWaitMonitoring();
    this.emit(this.waitingMessage());

    const authorizeUrl = buildAuthorizeUrl(state, watchBaseUrl);
    await assertPortalReachable(PORTAL_BASE_URL);
    try {
      await openUrl(authorizeUrl);
    } catch (e) {
      this.clearWaitWatchers();
      this.clearPendingMemory();
      await clearPendingAuth();
      this.status = 'signed_out';
      const msg = e instanceof Error ? e.message : 'Unable to open the browser';
      throw new Error(
        /not allowed|denied|permission|scope/i.test(msg)
          ? `Unable to open SkilledIM portal (${PORTAL_BASE_URL}). Check opener permissions / portal URL.`
          : msg
      );
    }
  }

  async cancelBrowserLogin(): Promise<void> {
    this.clearWaitWatchers();
    this.clearPendingMemory();
    await clearPendingAuth();
    if (this.status === 'waiting_for_browser') {
      this.status = 'signed_out';
      this.emit('Sign-in cancelled.');
    }
  }

  async handleCallbackUrl(raw: string): Promise<void> {
    if (this.handling) return;
    // Duplicate deep-link / loopback delivery after a successful sign-in.
    if (this.status === 'authenticated' && this.session) {
      return;
    }
    this.handling = true;
    // Cancel tab-close abandonment while we process the token.
    if (this.tabCloseGraceId != null) {
      clearTimeout(this.tabCloseGraceId);
      this.tabCloseGraceId = null;
    }
    try {
      const parsed = parseCallbackUrl(raw);
      if (parsed.error) {
        this.clearWaitWatchers();
        this.clearPendingMemory();
        this.status = 'signed_out';
        this.emit(parsed.error);
        await clearPendingAuth();
        return;
      }
      if (!parsed.token) {
        this.clearWaitWatchers();
        this.clearPendingMemory();
        this.status = 'signed_out';
        this.emit('Authorization callback did not include a token.');
        await clearPendingAuth();
        return;
      }
      if (!parsed.state) {
        this.clearWaitWatchers();
        this.clearPendingMemory();
        this.status = 'signed_out';
        this.emit('Authorization callback missing state.');
        await clearPendingAuth();
        return;
      }

      const stored = await loadPendingAuth();
      const pendingState = stored?.state ?? this.pendingState;
      const pendingCreatedAt = stored?.createdAt ?? this.pendingCreatedAt;
      if (!pendingState || pendingCreatedAt == null) {
        // Late duplicate after success, or abandon already cleared state.
        if (this.status === 'authenticated') return;
        this.clearWaitWatchers();
        this.status = 'signed_out';
        this.emit('No pending login. Start Login on SkilledIM again.');
        return;
      }
      if (pendingState !== parsed.state) {
        this.clearWaitWatchers();
        this.clearPendingMemory();
        this.status = 'signed_out';
        this.emit('Invalid login state. Possible CSRF — please try again.');
        await clearPendingAuth();
        return;
      }
      if (Date.now() - pendingCreatedAt > AUTH_STATE_TTL_MS) {
        this.clearWaitWatchers();
        this.clearPendingMemory();
        this.status = 'signed_out';
        this.emit('Login timed out. Please try again.');
        await clearPendingAuth();
        return;
      }
      if (isJwtExpired(parsed.token)) {
        this.clearWaitWatchers();
        this.clearPendingMemory();
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
      this.clearPendingMemory();
      this.clearWaitWatchers();
      this.status = 'authenticated';
      this.emit('Signed in through SkilledIM.');
    } catch (err) {
      this.clearWaitWatchers();
      this.clearPendingMemory();
      this.status = 'signed_out';
      this.emit(err instanceof Error ? err.message : 'Authorization failed');
      await clearPendingAuth();
    } finally {
      this.handling = false;
    }
  }

  async signOut(): Promise<void> {
    this.clearWaitWatchers();
    await api.signOut();
    this.session = null;
    this.status = 'signed_out';
    this.emit('Signed out.');
  }

  dispose(): void {
    this.clearWaitWatchers();
    for (const un of this.unlisteners) un();
    this.unlisteners = [];
    this.listeners.clear();
  }
}

export const browserAuth = new BrowserAuthService();
