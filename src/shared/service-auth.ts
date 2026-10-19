export const AUTH_STATE_CHANGED = 'tmm:auth:changed';
export const ACCOUNT_PASSWORD_MIN_LENGTH = 8;
export const ACCOUNT_PASSWORD_MAX_LENGTH = 24;
export type AppAuthState =
  | { status: 'signed-out' }
  | { status: 'blocked'; reason: 'service' | 'access' | 'configuration'; message: string }
  | {
      status: 'authenticated';
      user: { id: string; displayName: string; email: string };
      mustChangePassword: boolean;
    };
export function serviceEmailFromId(value: string): string | null {
  const id = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) ? `${id}@ilscp.net` : null;
}
