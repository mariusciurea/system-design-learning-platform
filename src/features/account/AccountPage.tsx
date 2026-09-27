import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CircleCheck, Loader2, LogIn, LogOut, MailCheck, MonitorSmartphone, Trash2, UserRound } from 'lucide-react';
import { Button, Meter } from '@/components/ui';
import { useAccount } from '@/app/providers/AccountProvider';
import { useProgress } from '@/app/providers/ProgressProvider';
import { DeleteAccountDialog } from './DeleteAccountDialog';

/** The Account of this device: who is signed in, and signing out. A Guest gets the way in. */
export function AccountPage() {
  const { status } = useAccount();
  const [deleted, setDeleted] = useState<{ firebaseUserDeleted: boolean } | null>(null);

  return (
    <div className="px-5 py-8 lg:px-8">
      <div className="mx-auto max-w-2xl">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Account</h1>
          <p className="mt-1.5 text-sm text-muted">Optional. Every page works the same for a Guest.</p>
        </header>

        {deleted && status === 'guest' ? <Deleted firebaseUserDeleted={deleted.firebaseUserDeleted} /> : null}
        {status === 'signed-in' ? (
          <SignedIn onDeleted={(firebaseUserDeleted) => setDeleted({ firebaseUserDeleted })} />
        ) : status === 'restoring' ? (
          <Restoring />
        ) : (
          <Guest />
        )}
      </div>
    </div>
  );
}

function SignedIn({ onDeleted }: { onDeleted: (firebaseUserDeleted: boolean) => void }) {
  const { email, confirmPending, signOut } = useAccount();
  const { overall, visited } = useProgress();
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const initial = email?.trim().charAt(0).toUpperCase();

  return (
    <>
      <section className="mt-6 rounded-2xl border border-line bg-surface p-5">
        <div className="flex items-center gap-4">
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand/15 text-lg font-semibold text-brand"
            aria-hidden
          >
            {initial || <UserRound className="h-5 w-5" />}
          </span>
          <div className="min-w-0">
            <p className="label">Signed in as</p>
            <p className="mt-0.5 break-all text-sm font-medium text-ink">{email ?? 'An Account with no email'}</p>
          </div>
        </div>
      </section>

      {confirmPending ? <ConfirmEmail email={email} /> : null}

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-ink">Progress</h2>
        <p className="mt-1 text-xs text-muted">Saved to your Account and synced to every device you sign in on.</p>
        <Link
          to="/progress"
          className="mt-3 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:border-brand/50 sm:gap-4"
        >
          <span className="shrink-0 text-sm text-ink">Progress</span>
          {/* The count beside it says it; the bar is only its picture. Always ok: done is never a warning. */}
          <div aria-hidden className="min-w-0 flex-1">
            <Meter value={overall.percent / 100} tone="ok" showValue={false} />
          </div>
          <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-muted">
            {overall.done}/{overall.total} Done
            {/* The opened count is extra; a phone keeps the row on one line without it. */}
            <span className="hidden sm:inline">, {Object.keys(visited).length} opened</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-faint" aria-hidden />
        </Link>
      </section>

      <section className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-6">
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setPending(true);
            // The page re-renders as a Guest when it resolves; nothing to reset.
            void signOut();
          }}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogOut className="h-4 w-4" aria-hidden />}
          {pending ? 'Signing out...' : 'Sign out'}
        </Button>
        <p className="min-w-0 flex-1 basis-60 text-xs text-muted">
          Signing out empties the progress on this device, so the next person here starts as an empty Guest.
        </p>
      </section>

      <section className="mt-8 rounded-2xl border border-danger/30 p-5">
        <h2 className="text-sm font-semibold text-ink">Delete my Account</h2>
        <p className="mt-1 text-xs text-muted">
          Deletes the Account and all the progress saved to it, on every device. It cannot be undone.
        </p>
        <Button variant="danger" className="mt-4" onClick={() => setDeleting(true)}>
          <Trash2 className="h-4 w-4" aria-hidden />
          Delete my Account
        </Button>
      </section>

      {deleting ? <DeleteAccountDialog onClose={() => setDeleting(false)} onDeleted={onDeleted} /> : null}
    </>
  );
}

/**
 * A password Account with no confirmed email. Saving works anyway (#179), but
 * until it is confirmed a Google sign-in for the same Gmail address replaces
 * the password, so the page asks for it and can send the email again.
 */
function ConfirmEmail({ email }: { email: string | null }) {
  const { sendConfirmEmail, refreshUser } = useAccount();
  const [sent, setSent] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  // A link clicked in the email changes nothing here until the user is read again:
  // on opening the page, and on coming back to the tab from the mail app.
  useEffect(() => {
    void refreshUser();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshUser();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshUser]);

  return (
    <section className="mt-6 rounded-2xl border border-warn/30 bg-warn/5 p-5">
      <div className="flex items-start gap-3">
        <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Confirm your email</h2>
          <p className="mt-1 text-xs text-muted">
            We sent a link to <span className="break-all">{email ?? 'your email'}</span> - look in your spam folder too. Your progress saves either way, but until you confirm it,
            signing in with Google for this email replaces your password.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              variant="secondary"
              aria-disabled={sent === 'sending'}
              onClick={() => {
                if (sent === 'sending') return;
                setSent('sending');
                void sendConfirmEmail().then((ok) => setSent(ok ? 'sent' : 'failed'));
              }}
            >
              {sent === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {sent === 'sending' ? 'Sending...' : 'Send the email again'}
            </Button>
            <p className="text-xs text-muted" role="status">
              {sent === 'sent'
                ? 'Sent. Check your inbox and your spam folder.'
                : sent === 'failed'
                  ? 'Could not send it. Wait a few minutes and try again.'
                  : null}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Deleted({ firebaseUserDeleted }: { firebaseUserDeleted: boolean }) {
  // The dialog and the button that opened it are gone: focus lands here, not on the page body.
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => notice.current?.focus(), []);

  return (
    <div
      ref={notice}
      tabIndex={-1}
      className="mt-6 flex items-start gap-3 rounded-2xl border border-ok/30 bg-ok/5 p-5 outline-none"
      role="status"
    >
      <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-ink">Your Account was deleted, with all the progress saved to it.</p>
        <p className="mt-1 text-muted">
          This device is now an empty Guest.
          {firebaseUserDeleted
            ? null
            : ' The sign-in itself could not be removed. Signing in with it again starts a fresh, empty Account.'}
        </p>
      </div>
    </div>
  );
}

function Restoring() {
  return (
    <div className="mt-6 flex items-center gap-2 rounded-2xl border border-line bg-surface p-5 text-sm text-muted" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Checking your sign-in...
    </div>
  );
}

function Guest() {
  const { available, openSignIn } = useAccount();

  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-start gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-elevated text-muted" aria-hidden>
          <MonitorSmartphone className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">You are a Guest</p>
          <p className="mt-1 text-sm text-muted">
            Your progress lives in this browser only. Clearing site data or switching device starts it over.
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {available ? (
          <Button variant="primary" onClick={openSignIn}>
            <LogIn className="h-4 w-4" aria-hidden />
            Sign in
          </Button>
        ) : (
          <p className="text-xs text-muted">Sign-in is not available in this version of the app.</p>
        )}
        <Link
          to="/progress"
          className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm text-muted transition-colors hover:bg-elevated hover:text-ink"
        >
          See your progress
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

export default AccountPage;
