// Live refresh by polling `/api/map` with If-None-Match: an unchanged map costs a 304
// and no re-render. No SSE or WebSocket (the server is plain read-only HTTP).
import type { MapJson } from './model.js';

export const POLL_MS = 3000;

export type MapUpdate =
  | { kind: 'map'; map: MapJson }
  /** chunks.json is missing (or has no root): show the "run `gotchea scan`" screen. */
  | { kind: 'not_scanned' }
  /** Server unreachable or an unexpected answer; the last map stays on screen. */
  | { kind: 'offline'; message: string }
  /** Back online after `offline` and the map did not change meanwhile (304). */
  | { kind: 'reconnected' };

export type FetchLike = (url: string, init: { headers: Record<string, string>; cache: RequestCache }) => Promise<Response>;

/** The timer pair of `window` (browser) or `globalThis` (tests). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface Poller {
  /** Fetches now; resolves to null when the map is unchanged (304). */
  poll(): Promise<MapUpdate | null>;
  start(onUpdate: (u: MapUpdate) => void): void;
  stop(): void;
}

export function createPoller(fetchFn: FetchLike, intervalMs: number, timers: Timers): Poller {
  let etag: string | null = null;
  let last: MapUpdate['kind'] | null = null;
  let timer: number | null = null;
  let stopped = true;

  const poll = async (): Promise<MapUpdate | null> => {
    let res: Response;
    try {
      res = await fetchFn('/api/map', { headers: etag ? { 'If-None-Match': etag } : {}, cache: 'no-cache' });
    } catch {
      return remember({ kind: 'offline', message: 'Lost connection to `gotchea serve`.' });
    }
    if (res.status === 304) {
      if (last !== 'offline') return null;
      last = 'map';
      return { kind: 'reconnected' };
    }
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === 'not_scanned' || body?.error === 'no_root') {
        etag = null;
        return remember({ kind: 'not_scanned' });
      }
    }
    if (!res.ok) return remember({ kind: 'offline', message: `Server answered ${res.status}.` });
    const map = (await res.json()) as MapJson;
    etag = res.headers.get('ETag');
    return remember({ kind: 'map', map });
  };

  // Repeated not-scanned/offline answers do not re-render either.
  const remember = (u: MapUpdate): MapUpdate | null => {
    if (u.kind !== 'map' && last === u.kind) return null;
    last = u.kind;
    return u;
  };

  const loop = (onUpdate: (u: MapUpdate) => void): void => {
    void poll().then((u) => {
      if (stopped) return;
      if (u) onUpdate(u);
      timer = timers.setTimeout(() => loop(onUpdate), intervalMs);
    });
  };

  return {
    poll,
    start(onUpdate) {
      if (!stopped) return;
      stopped = false;
      loop(onUpdate);
    },
    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
