'use client';

import { getToken } from '@/core/session';
import type { PageCursor } from '@/core/sales';

/**
 * The browser-side admin API client. Thin: it calls the route handlers, never the database. A
 * failed write that looks like a network error is queued in the IndexedDB outbox so an offline
 * branch admin does not lose the edit (ADR-0052).
 */

export class AdminApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'AdminApiError';
  }
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: authHeaders() };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(path, init);
  const text = await response.text();
  const payload = text === '' ? null : (JSON.parse(text) as unknown);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `request failed with status ${response.status}`;
    throw new AdminApiError(response.status, message);
  }
  return payload as T;
}

export function adminGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function adminPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export function adminPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

export function adminDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}

/** Append the keyset cursor to a path's query string (never an offset). */
export function withCursor(path: string, cursor: PageCursor | null): string {
  if (!cursor) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}after_created_at=${encodeURIComponent(cursor.createdAt)}&after_id=${encodeURIComponent(cursor.id)}`;
}
