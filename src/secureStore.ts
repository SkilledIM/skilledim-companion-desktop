import { invoke } from '@tauri-apps/api/core';

export interface PendingAuth {
  state: string;
  createdAt: number;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** In-memory fallback used only for Vite browser previews (not production desktop). */
const memory = {
  token: null as string | null,
  pending: null as PendingAuth | null,
  profile: null as string | null,
};

export async function storeToken(token: string): Promise<void> {
  if (!isTauriRuntime()) {
    memory.token = token;
    return;
  }
  await invoke('secure_store_token', { token });
}

export async function loadToken(): Promise<string | null> {
  if (!isTauriRuntime()) return memory.token;
  return invoke<string | null>('secure_load_token');
}

export async function clearToken(): Promise<void> {
  if (!isTauriRuntime()) {
    memory.token = null;
    return;
  }
  await invoke('secure_clear_token');
}

export async function storePendingAuth(pending: PendingAuth): Promise<void> {
  if (!isTauriRuntime()) {
    memory.pending = pending;
    return;
  }
  await invoke('secure_store_pending_auth', { pending });
}

export async function loadPendingAuth(): Promise<PendingAuth | null> {
  if (!isTauriRuntime()) return memory.pending;
  return invoke<PendingAuth | null>('secure_load_pending_auth');
}

export async function clearPendingAuth(): Promise<void> {
  if (!isTauriRuntime()) {
    memory.pending = null;
    return;
  }
  await invoke('secure_clear_pending_auth');
}

export async function storeProfileJson(profileJson: string): Promise<void> {
  if (!isTauriRuntime()) {
    memory.profile = profileJson;
    return;
  }
  await invoke('secure_store_profile', { profileJson });
}

export async function loadProfileJson(): Promise<string | null> {
  if (!isTauriRuntime()) return memory.profile;
  return invoke<string | null>('secure_load_profile');
}

export async function clearAllSecure(): Promise<void> {
  if (!isTauriRuntime()) {
    memory.token = null;
    memory.pending = null;
    memory.profile = null;
    return;
  }
  await invoke('secure_clear_all');
}

export { isTauriRuntime };
