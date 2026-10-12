export interface JwtClaims {
  exp?: number;
  iat?: number;
  sub?: string;
  [key: string]: unknown;
}

/** Decode JWT payload without verifying the signature (API validates authenticity). */
export function decodeJwtPayload(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

export function isJwtExpired(token: string, skewSeconds = 30): boolean {
  const claims = decodeJwtPayload(token);
  if (!claims?.exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return claims.exp <= now + skewSeconds;
}

export function jwtExpiresAt(token: string): Date | null {
  const claims = decodeJwtPayload(token);
  if (!claims?.exp) return null;
  return new Date(claims.exp * 1000);
}
