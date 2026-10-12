/**
 * SkilledIM API Client
 * Aligned with https://api.skilledim.com/api-docs
 *
 * Authentication uses browser JWT handoff + POST /api/auth/validate-token.
 * The Companion never collects email/password.
 */

import { API_BASE_URL } from './config';
import { companionFetch } from './http';
import { isJwtExpired } from './jwt';
import { clearAllSecure, loadToken, storeToken } from './secureStore';

export { API_BASE_URL };

export interface UserSession {
  token: string;
  userId: number;
  employeeId: number;
  organizationId: number;
  email: string;
  name: string;
  role: string;
  companyName: string;
  companyLogoUrl?: string;
  expiresAt?: string | null;
}

export interface AttendanceStatus {
  action: 'CHECK_IN' | 'CHECK_OUT';
  attendanceId: number | null;
  date: string;
  checkInTime: string | null;
  checkOutTime: string | null;
}

/** In-memory access token for the current process (source of truth is OS keyring). */
let memoryToken: string | null = null;

class SkilledImApi {
  setMemoryToken(token: string | null): void {
    memoryToken = token;
  }

  getMemoryToken(): string | null {
    return memoryToken;
  }

  private getHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (memoryToken) {
      headers.Authorization = `Bearer ${memoryToken}`;
    }
    return headers;
  }

  private async parseError(response: Response, fallback: string): Promise<string> {
    const errData = await response.json().catch(() => ({} as Record<string, unknown>));
    const data = (errData as { data?: { manualMessage?: string }; message?: string }).data;
    return (
      (errData as { message?: string }).message ||
      data?.manualMessage ||
      fallback
    );
  }

  private mapSession(data: Record<string, unknown>, token: string): UserSession {
    const user = (data.user as Record<string, unknown>) || {};
    const employee = (data.employee as Record<string, unknown>) || {};
    const organization = (data.organization as Record<string, unknown>) || {};
    const firstName = String(data.firstName || user.firstName || '');
    const lastName = String(data.lastName || user.lastName || '');
    const composedName = `${firstName} ${lastName}`.trim();

    return {
      token,
      userId: Number(data.userId || user.id || 0),
      employeeId: Number(
        data.employeeId || employee.id || user.employeeId || 0
      ),
      organizationId: Number(
        data.organizationId || organization.id || user.organizationId || 0
      ),
      email: String(data.email || user.email || ''),
      name: String(
        data.name || user.name || composedName || 'SkilledIM Agent'
      ),
      role: String(data.role || user.role || 'Agent'),
      companyName: String(
        data.organizationName || organization.name || 'SkilledIM'
      ),
      companyLogoUrl: (data.organizationLogo ||
        organization.logoUrl) as string | undefined,
    };
  }

  /**
   * Existing SkilledIM cross-domain auth endpoint.
   * POST /api/auth/validate-token?token=...
   */
  async validateToken(token: string): Promise<UserSession> {
    const url = `${API_BASE_URL}/api/auth/validate-token?token=${encodeURIComponent(token)}`;
    const response = await companionFetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(await this.parseError(response, 'Token validation failed'));
    }
    const resJson = await response.json();
    if (resJson.success === false) {
      throw new Error(resJson.message || 'Token validation failed');
    }
    const data = (resJson.data || resJson) as Record<string, unknown>;
    const session = this.mapSession(data, token);
    if (!session.employeeId || !session.organizationId) {
      // Fall back to /api/auth/session for richer context when validate-token is sparse.
      const enriched = await this.tryCurrentSession(token, session);
      if (!enriched.employeeId || !enriched.organizationId) {
        throw new Error(
          'Authorized, but employee/organization context is missing. Contact your admin.'
        );
      }
      return enriched;
    }
    return session;
  }

  private async tryCurrentSession(
    token: string,
    fallback: UserSession
  ): Promise<UserSession> {
    this.setMemoryToken(token);
    try {
      const response = await companionFetch(`${API_BASE_URL}/api/auth/session`, {
        method: 'GET',
        headers: this.getHeaders(),
      });
      if (!response.ok) return fallback;
      const resJson = await response.json();
      const data = (resJson.data || resJson) as Record<string, unknown>;
      return this.mapSession({ ...fallback, ...data }, token);
    } catch {
      return fallback;
    }
  }

  async restoreSession(): Promise<UserSession | null> {
    const token = await loadToken();
    if (!token) {
      this.setMemoryToken(null);
      return null;
    }
    if (isJwtExpired(token)) {
      await clearAllSecure();
      this.setMemoryToken(null);
      return null;
    }
    this.setMemoryToken(token);
    try {
      const session = await this.validateToken(token);
      await storeToken(token);
      this.setMemoryToken(token);
      return session;
    } catch {
      await clearAllSecure();
      this.setMemoryToken(null);
      return null;
    }
  }

  async establishSessionFromToken(token: string): Promise<UserSession> {
    if (isJwtExpired(token)) {
      throw new Error('The authorization token has expired. Please sign in again.');
    }
    const session = await this.validateToken(token);
    await storeToken(token);
    this.setMemoryToken(token);
    return session;
  }

  async signOut(): Promise<void> {
    try {
      if (memoryToken) {
        await companionFetch(`${API_BASE_URL}/api/auth/signout`, {
          method: 'POST',
          headers: this.getHeaders(),
        });
      }
    } catch (e) {
      console.warn('Signout warning:', e);
    } finally {
      this.setMemoryToken(null);
      await clearAllSecure();
      // Remove legacy insecure keys from earlier builds.
      try {
        localStorage.removeItem('skilledim_token');
        localStorage.removeItem('skilledim_user_session');
        localStorage.removeItem('skilledim_session');
        localStorage.removeItem('authToken');
      } catch {
        /* ignore */
      }
    }
  }

  async getAttendanceStatus(
    organizationId: number,
    employeeId: number
  ): Promise<AttendanceStatus> {
    const url = `${API_BASE_URL}/api/organizations/${organizationId}/employee-self/${employeeId}/attendance/status`;
    const response = await companionFetch(url, { method: 'GET', headers: this.getHeaders() });
    if (!response.ok) {
      throw new Error(await this.parseError(response, 'Failed to load attendance status'));
    }
    const resJson = await response.json();
    const data = resJson.data || {};
    return {
      action:
        data.action ||
        (data.checkInTime && !data.checkOutTime ? 'CHECK_OUT' : 'CHECK_IN'),
      attendanceId: data.attendanceId ?? null,
      date: data.date || new Date().toISOString().split('T')[0],
      checkInTime: data.checkInTime || null,
      checkOutTime: data.checkOutTime || null,
    };
  }

  async checkIn(
    organizationId: number,
    employeeId: number
  ): Promise<AttendanceStatus> {
    const today = new Date().toISOString().split('T')[0];
    const url = `${API_BASE_URL}/api/organizations/${organizationId}/attendance/employee/${employeeId}/check-in`;
    const response = await companionFetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ date: today, medium: 'WEBSITE', location: null }),
    });
    if (!response.ok) {
      throw new Error(await this.parseError(response, 'Check-in request failed'));
    }
    return this.getAttendanceStatus(organizationId, employeeId);
  }

  async checkOut(
    organizationId: number,
    employeeId: number,
    attendanceId: number
  ): Promise<AttendanceStatus> {
    const url = `${API_BASE_URL}/api/organizations/${organizationId}/attendance/employee/${employeeId}/attendance/${attendanceId}/check-out`;
    const response = await companionFetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ medium: 'WEBSITE', location: null }),
    });
    if (!response.ok) {
      throw new Error(await this.parseError(response, 'Check-out request failed'));
    }
    return this.getAttendanceStatus(organizationId, employeeId);
  }

  async getWeeklyAttendance(
    organizationId: number,
    employeeId: number,
    startDate: string,
    endDate: string
  ): Promise<Record<string, unknown>[]> {
    const url =
      `${API_BASE_URL}/api/organizations/${organizationId}/attendance/employee/${employeeId}` +
      `/date-range?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&size=100`;
    const response = await companionFetch(url, { method: 'GET', headers: this.getHeaders() });
    if (!response.ok) return [];
    const resJson = await response.json();
    const data = resJson.data;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.content)) return data.content;
    return [];
  }
}

export const api = new SkilledImApi();
