import { lazy, type ComponentType } from 'react';
import { safeSessionStorage } from './safeStorage';

const RELOAD_FLAG = 'sdi:chunk-reload';

/**
 * `React.lazy` that survives a stale chunk reference.
 *
 * Every lab and page is code-split, so the browser fetches its module on first
 * use. If the dev server restarted or a new build was deployed since the page
 * loaded, that fetch fails with "Failed to fetch dynamically imported module"
 * and the whole view crashes. Retrying once fixes a transient failure; a single
 * guarded reload fixes a genuinely stale document.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const module = await factory();
      safeSessionStorage.remove(RELOAD_FLAG);
      return module;
    } catch {
      // A single retry covers a momentary network or dev-server hiccup.
      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const module = await factory();
        safeSessionStorage.remove(RELOAD_FLAG);
        return module;
      } catch (retryError) {
        // Offline, a reload would swap the whole app for the browser's own error
        // page and lose the tab. Let the ErrorBoundary say so instead.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw retryError;
        const alreadyReloaded = safeSessionStorage.get(RELOAD_FLAG) === '1';
        if (!alreadyReloaded && typeof window !== 'undefined') {
          safeSessionStorage.set(RELOAD_FLAG, '1');
          // Without storage the flag cannot survive the reload, so reloading
          // would loop forever - surface the error to the boundary instead.
          if (safeSessionStorage.get(RELOAD_FLAG) !== '1') throw retryError;
          // The document references chunks that no longer exist - reload once.
          window.location.reload();
          // Keep the promise pending while the page reloads.
          return new Promise<{ default: T }>(() => {});
        }
        throw retryError;
      }
    }
  });
}
