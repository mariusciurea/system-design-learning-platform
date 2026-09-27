import { useEffect, useRef, useState, type RefObject } from 'react';

const SITE_TITLE = 'System Design Interactive';
/** Longest wait for the new page's h1 (a lazy page on a slow network) before giving up. */
const GIVE_UP_MS = 8000;

/**
 * What a full page load does for free, done for an in-app navigation:
 * - the tab title names the page, from its h1 ("Load Balancing - System Design Interactive"),
 * - a screen reader hears that name, through the returned `announcement` (render it in a polite
 *   live region),
 * - focus moves to `main`, so the next Tab starts in the new page, not at the link that was
 *   clicked in the sidebar.
 *
 * It reads the h1 instead of each page setting its own title, so a new page (and every "not
 * found" branch) is covered with no wiring. Pages are lazy and may keep the old page on screen
 * while the new chunk loads, so it waits for an h1 that is a different element or has a different
 * text from the one it named last time. (Not the one on screen when this runs: a cached page is
 * already rendered by then.) The first load sets the title only: the browser
 * has already announced the page and put focus at its start.
 */
export function useRouteAnnouncer(pathname: string, mainRef: RefObject<HTMLElement | null>) {
  const [announcement, setAnnouncement] = useState('');
  const firstLoad = useRef(true);
  const named = useRef<{ heading: HTMLHeadingElement | null; text: string }>({ heading: null, text: '' });

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const isFirstLoad = firstLoad.current;
    firstLoad.current = false;
    const last = named.current;
    const focusAtNavigation = document.activeElement;

    const apply = (heading: HTMLHeadingElement | null) => {
      named.current = { heading, text: heading?.textContent ?? '' };
      // The home page's h1 is the product name itself.
      const name = pathname === '/' ? '' : (heading?.textContent ?? '').replace(/\s+/g, ' ').trim();
      document.title = name ? `${name} - ${SITE_TITLE}` : SITE_TITLE;
      if (isFirstLoad) return;
      setAnnouncement(name || SITE_TITLE);
      // Never pull focus away from something the Learner moved to while the page loaded, or out of a dialog.
      const untouched = document.activeElement === focusAtNavigation || document.activeElement === document.body;
      if (untouched && !document.querySelector('[aria-modal="true"]')) main.focus({ preventScroll: true });
    };

    const findNew = () => {
      const heading = main.querySelector('h1');
      if (!heading) return null;
      if (heading === last.heading && heading.textContent === last.text) return null;
      return heading;
    };

    const ready = findNew();
    if (ready) {
      apply(ready);
      return;
    }
    const observer = new MutationObserver(() => {
      const heading = findNew();
      if (!heading) return;
      stop();
      apply(heading);
    });
    // Two routes with the same heading ("not found" to "not found") never change it: name it anyway.
    const timer = window.setTimeout(() => {
      stop();
      apply(main.querySelector('h1'));
    }, GIVE_UP_MS);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    return stop;
  }, [pathname, mainRef]);

  return announcement;
}
