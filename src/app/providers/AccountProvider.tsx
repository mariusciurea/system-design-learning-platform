import {
  Suspense,
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AlertTriangle, RotateCcw, WifiOff } from 'lucide-react';
import { Button, ErrorBoundary, Modal } from '@/components/ui';
import { safeLocalStorage } from '@/utils/safeStorage';
import { lazyWithRetry } from '@/utils/lazyWithRetry';
import {
  ACCOUNT_MARK_KEY,
  afterAuthChange,
  afterMarkChange,
  firebaseConfigFrom,
  startStatus,
  type AccountStatus,
  type AccountUser,
  type FirebaseWebConfig,
} from '@/app/account/accountState';
import { apiFetch, apiUrlFrom, type ApiResult } from '@/app/account/api';
import type { AuthSession } from '@/features/account/firebase';

// A failed lazy import stays failed for the life of that lazy component, so "Try again" makes a new one.
const loadSignInDialog = () => lazyWithRetry(() => import('@/features/account/SignInDialog'));

const FIREBASE_CONFIG = firebaseConfigFrom({
  VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY,
  VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID,
});
const API_URL = apiUrlFrom(import.meta.env.VITE_API_URL);

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Sent as JSON. */
  body?: unknown;
  timeoutMs?: number;
}

/** How deleting the Account ended. Nothing is deleted when the proof (`confirm`) or the server call fails. */
export type DeleteAccountResult =
  | { ok: true; firebaseUserDeleted: boolean }
  | { ok: false; step: 'confirm'; error: unknown }
  | { ok: false; step: 'server'; reason: Extract<ApiResult<unknown>, { ok: false }>['reason'] };

interface AccountContextValue {
  status: AccountStatus;
  email: string | null;
  /** A password Account whose email is not confirmed yet - see AccountUser.confirmPending. */
  confirmPending: boolean;
  /** Sends the confirm email again. Resolves false when it could not be sent. */
  sendConfirmEmail: () => Promise<boolean>;
  /** Reads the user again, so a confirm link clicked meanwhile shows. Quiet on failure. */
  refreshUser: () => Promise<void>;
  /** False in a build without the VITE_FIREBASE_* settings: no Sign in anywhere, everyone is a Guest. */
  available: boolean;
  openSignIn: () => void;
  /** Signs out and empties the progress on this device - see onSignedOut. */
  signOut: () => Promise<void>;
  /** The Firebase ID token, or null for a Guest or when it cannot be refreshed (offline). */
  getIdToken: () => Promise<string | null>;
  /**
   * A call to the API with the ID token. Never throws and never blocks a
   * render; a 410 (Account deleted) signs out before it returns.
   */
  request: <T>(path: string, init?: ApiRequest) => Promise<ApiResult<T>>;
  /**
   * Runs when the Account leaves this device (sign-out, a 410, or a session
   * that ended elsewhere). ProgressProvider empties local progress here.
   * Returns the unsubscribe.
   */
  onSignedOut: (listener: () => void) => () => void;
  /** What deleting the Account asks for to prove it is the Learner: the Google popup or the password. */
  reauthMethod: () => 'google' | 'password' | null;
  /**
   * Deletes the Account and everything saved to it, then leaves an empty Guest.
   * Pass the password for a password Account; without one it opens the Google
   * popup, so call it straight from the click.
   */
  deleteAccount: (password?: string) => Promise<DeleteAccountResult>;
}

// ---------------------------------------------------------------------------
// The Firebase SDK, loaded on demand. One retry covers a momentary network
// hiccup; a failure is forgotten, so the next Sign in click tries again.

type FirebaseModule = typeof import('@/features/account/firebase');
let firebaseModule: Promise<FirebaseModule> | null = null;

function loadFirebase(): Promise<FirebaseModule> {
  firebaseModule ??= import('@/features/account/firebase')
    .catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return import('@/features/account/firebase');
    })
    .catch((error: unknown) => {
      firebaseModule = null;
      throw error;
    });
  return firebaseModule;
}

// ---------------------------------------------------------------------------
// The Account on this device, as an external store: Firebase calls into it
// from outside React, and React reads it with useSyncExternalStore.

interface Snapshot {
  status: AccountStatus;
  email: string | null;
  confirmPending: boolean;
  /** The SDK is loaded and Auth is up: a click can open the popup at once. */
  sessionReady: boolean;
  /** The SDK could not be downloaded (offline, flaky network). Cleared by the next try. */
  sessionFailed: boolean;
  signInOpen: boolean;
}

const hasMark = () => safeLocalStorage.get(ACCOUNT_MARK_KEY) !== null;

function createAccountStore(config: FirebaseWebConfig | null, apiUrl: string | null) {
  let snapshot: Snapshot = {
    status: startStatus({ configured: Boolean(config), marked: hasMark() }),
    email: null,
    confirmPending: false,
    sessionReady: false,
    sessionFailed: false,
    signInOpen: false,
  };
  const listeners = new Set<() => void>();
  const signedOutListeners = new Set<() => void>();
  let session: AuthSession | null = null;
  let starting: Promise<AuthSession | null> | null = null;
  /**
   * While "Delete my Account" runs, a 410 (from a save in flight, or from
   * DELETE /me itself) must not sign out yet: the Firebase user still has to
   * be deleted, and the flow signs out itself at the end.
   */
  let deleting = false;

  const update = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  function applyUser(user: AccountUser | null) {
    const previous = snapshot.status;
    const change = afterAuthChange(user, { previous, marked: hasMark() });
    if (change.mark === 'set') safeLocalStorage.set(ACCOUNT_MARK_KEY, '1');
    if (change.mark === 'remove') safeLocalStorage.remove(ACCOUNT_MARK_KEY);
    if (change.clearProgress) for (const listener of signedOutListeners) listener();
    update({
      status: change.status,
      email: change.email,
      confirmPending: change.confirmPending,
      ...(user ? { signInOpen: false } : {}),
    });
    // Creates the Account row on first contact, and finds out about a deleted
    // Account (410). In the background: nothing waits for it, a failure is silent.
    if (user && previous !== 'signed-in') void request('/me');
  }

  function ensureSession(): Promise<AuthSession | null> {
    if (!config) return Promise.resolve(null);
    starting ??= loadFirebase().then(
      ({ startAuth }) => {
        session = startAuth(config);
        session.onUserChange(applyUser);
        update({ sessionReady: true, sessionFailed: false });
        return session;
      },
      () => {
        // Offline with the SDK not cached. Keep the mark, so the next start tries
        // again, and show a Guest meanwhile - every page works either way.
        starting = null;
        update({ sessionFailed: true, ...(snapshot.status === 'restoring' ? { status: 'guest' as const } : {}) });
        return null;
      },
    );
    return starting;
  }

  async function getIdToken(): Promise<string | null> {
    if (!session || snapshot.status !== 'signed-in') return null;
    try {
      return await session.getIdToken();
    } catch {
      return null;
    }
  }

  async function signOut() {
    // A Guest has nothing to sign out of, and must not download Firebase for it.
    const current = snapshot.status === 'guest' ? session : await ensureSession();
    try {
      await current?.signOut();
    } catch {
      // Firebase clears its own storage even when the network call fails.
    }
    // Firebase reports the change too; applying it here as well means signOut
    // resolves with progress already cleared. The second report is a no-op.
    applyUser(null);
  }

  async function request<T>(path: string, init: ApiRequest = {}): Promise<ApiResult<T>> {
    if (!apiUrl) return { ok: false, status: 0, reason: 'unavailable' };
    const token = await getIdToken();
    if (!token) return { ok: false, status: 0, reason: snapshot.status === 'signed-in' ? 'offline' : 'unavailable' };
    const result = await apiFetch<T>(path, { baseUrl: apiUrl, token, ...init });
    if (!result.ok && result.reason === 'gone' && !deleting) await signOut();
    return result;
  }

  /** The session for an email and password action; the SDK failing to load reads as "no connection". */
  async function sessionForEmail(): Promise<AuthSession> {
    const current = session ?? (await ensureSession());
    if (!current) throw Object.assign(new Error('Sign-in could not load'), { code: 'auth/network-request-failed' });
    return current;
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    /** A browser that was signed in here loads Firebase at start. */
    restore() {
      if (snapshot.status === 'restoring') void ensureSession();
    },
    /** Another tab set or removed the mark: a Guest tab follows a sign-in made there. */
    markChanged() {
      const next = afterMarkChange({ status: snapshot.status, configured: Boolean(config), marked: hasMark() });
      if (next !== 'restore') return;
      update({ status: 'restoring' });
      void ensureSession();
    },
    async sendConfirmEmail(): Promise<boolean> {
      if (!session || snapshot.status !== 'signed-in') return false;
      try {
        await session.sendConfirmEmail();
        return true;
      } catch {
        return false;
      }
    },
    async refreshUser() {
      if (!session || snapshot.status !== 'signed-in') return;
      try {
        const user = await session.refreshUser();
        if (user) applyUser(user);
      } catch {
        // Offline: the old answer stays until the next try.
      }
    },
    openSignIn() {
      if (!config) return;
      update({ signInOpen: true, sessionFailed: false });
      void ensureSession();
    },
    /** The dialog's "Try again" after the SDK failed to download. */
    retrySession() {
      update({ sessionFailed: false });
      void ensureSession();
    },
    closeSignIn: () => update({ signInOpen: false }),
    /** Synchronous up to the popup: it must open inside the click, or the browser blocks it. */
    signInWithGoogle(): Promise<void> {
      if (!session) return Promise.reject(new Error('Sign-in is still loading'));
      return session.signInWithGoogle();
    },
    /** Email and password open no popup, so unlike Google they may wait for the SDK to load. */
    emailAuth: {
      signInWithEmail: async (email: string, password: string) =>
        (await sessionForEmail()).signInWithEmail(email, password),
      signUpWithEmail: async (email: string, password: string) =>
        (await sessionForEmail()).signUpWithEmail(email, password),
      sendPasswordReset: async (email: string) => (await sessionForEmail()).sendPasswordReset(email),
    },
    signOut,
    getIdToken,
    request,
    onSignedOut(listener: () => void) {
      signedOutListeners.add(listener);
      return () => {
        signedOutListeners.delete(listener);
      };
    },
    reauthMethod: () => (snapshot.status === 'signed-in' ? (session?.reauthMethod() ?? null) : null),
    /**
     * Proves it is the Learner again (Firebase deletes a user only after a
     * recent sign-in), then DELETE /me removes every row on the server, then
     * the Firebase user goes and this device becomes an empty Guest.
     * Synchronous up to the Google popup: no await before it.
     */
    deleteAccount(password?: string): Promise<DeleteAccountResult> {
      const current = snapshot.status === 'signed-in' ? session : null;
      if (!current) return Promise.resolve({ ok: false, step: 'server', reason: 'unavailable' });
      const proof = password === undefined ? current.reauthenticateWithGoogle() : current.reauthenticateWithPassword(password);
      return proof.then(
        async (): Promise<DeleteAccountResult> => {
          deleting = true;
          try {
            const result = await request<void>('/me', { method: 'DELETE' });
            // A 410: deleted already - by an earlier try whose answer was lost, or from another device.
            if (!result.ok && result.reason !== 'gone') return { ok: false, step: 'server', reason: result.reason };
            let firebaseUserDeleted = false;
            try {
              await current.deleteUser();
              firebaseUserDeleted = true;
            } catch {
              // The server rows are gone either way. The server refuses this sign-in
              // now (410); a later sign-in gets a fresh, empty Account.
            }
            await signOut();
            return { ok: true, firebaseUserDeleted };
          } finally {
            deleting = false;
          }
        },
        (error: unknown): DeleteAccountResult => ({ ok: false, step: 'confirm', error }),
      );
    },
  };
}

const store = createAccountStore(FIREBASE_CONFIG, API_URL);

const AccountContext = createContext<AccountContextValue | null>(null);

/**
 * The optional Account (see CONTEXT.md and docs/adr/0001). A Guest never
 * downloads Firebase: the SDK loads when the Learner opens sign-in, or at start
 * when this browser carries the "was signed in here" mark.
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [SignInDialog, setSignInDialog] = useState(loadSignInDialog);

  useEffect(() => store.restore(), []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACCOUNT_MARK_KEY || event.key === null) store.markChanged();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<AccountContextValue>(
    () => ({
      status: snapshot.status,
      email: snapshot.email,
      confirmPending: snapshot.confirmPending,
      sendConfirmEmail: store.sendConfirmEmail,
      refreshUser: store.refreshUser,
      available: Boolean(FIREBASE_CONFIG),
      openSignIn: store.openSignIn,
      signOut: store.signOut,
      getIdToken: store.getIdToken,
      request: store.request,
      onSignedOut: store.onSignedOut,
      reauthMethod: store.reauthMethod,
      deleteAccount: store.deleteAccount,
    }),
    [snapshot.status, snapshot.email, snapshot.confirmPending],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
      {snapshot.signInOpen ? (
        // Its own boundary: this sits outside the router, so a failed download here would
        // otherwise replace every page with the application crash screen.
        <ErrorBoundary
          area="Sign in"
          fallback={(_error, reset) => (
            <SignInUnavailable
              onClose={store.closeSignIn}
              onRetry={() => {
                setSignInDialog(() => loadSignInDialog());
                reset();
              }}
            />
          )}
        >
          <Suspense fallback={null}>
            <SignInDialog
              ready={snapshot.sessionReady}
              failed={snapshot.sessionFailed}
              onRetry={store.retrySession}
              onGoogle={store.signInWithGoogle}
              emailAuth={store.emailAuth}
              onClose={store.closeSignIn}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}
    </AccountContext.Provider>
  );
}

/** Stands in for the sign-in dialog when its code could not be downloaded. */
function SignInUnavailable({ onClose, onRetry }: { onClose: () => void; onRetry: () => void }) {
  const titleId = useId();
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const Icon = offline ? WifiOff : AlertTriangle;
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      className="items-start justify-center overflow-y-auto bg-black/50 px-4 pb-4 pt-[12vh] backdrop-blur-sm short:pt-4"
      panelClassName="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-card"
    >
      <div role="alert" className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold text-ink">
            Sign-in could not load
          </h2>
          <p className="mt-1 text-sm text-muted">
            {offline
              ? 'You are offline. Reconnect, then try again. Every page still works without an Account.'
              : 'The connection dropped while it was downloading. Try again. Every page still works without an Account.'}
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={onRetry}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    </Modal>
  );
}

export function useAccount() {
  const context = useContext(AccountContext);
  if (!context) throw new Error('useAccount must be used inside AccountProvider');
  return context;
}
