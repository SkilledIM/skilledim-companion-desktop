/**
 * HTTP helper for Companion.
 *
 * Desktop WebView fetch is subject to browser CORS. Production API CORS is
 * oriented at portal.skilledim.com, so validate-token and attendance calls
 * fail with "Failed to fetch" from the Tauri WebView. Use the Tauri HTTP
 * plugin (Rust reqwest) in the desktop runtime to bypass that restriction.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriRuntime } from './secureStore';

export type CompanionRequestInit = {
  method?: string;
  headers?: HeadersInit;
  body?: string | null;
};

export async function companionFetch(
  input: string,
  init: CompanionRequestInit = {}
): Promise<Response> {
  try {
    if (isTauriRuntime()) {
      return await tauriFetch(input, {
        method: init.method || 'GET',
        headers: init.headers,
        body: init.body ?? undefined,
      });
    }
    return await fetch(input, {
      method: init.method || 'GET',
      headers: init.headers,
      body: init.body ?? undefined,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed|error sending request/i.test(raw)) {
      throw new Error(
        'Unable to reach SkilledIM API. Check your network connection and try again.'
      );
    }
    throw err instanceof Error ? err : new Error(raw);
  }
}
