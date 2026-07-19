import { setAuthTokenGetter } from '@workspace/api-client-react';

export function getToken(): string | null {
  return localStorage.getItem('bot_admin_token');
}

export function setToken(token: string) {
  localStorage.setItem('bot_admin_token', token);
}

export function removeToken() {
  localStorage.removeItem('bot_admin_token');
}

setAuthTokenGetter(getToken);
