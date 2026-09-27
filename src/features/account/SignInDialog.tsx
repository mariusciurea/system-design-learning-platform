import { forwardRef, useEffect, useId, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { CircleCheck, Loader2, UserRound, X } from 'lucide-react';
import { Button, Modal, SegmentedControl } from '@/components/ui';
import { cn } from '@/utils/cn';
import type { AuthSession } from './firebase';
import { emailFromSignInError, passwordResetErrorMessage, signInErrorMessage } from './signInErrors';

type EmailAuth = Pick<AuthSession, 'signInWithEmail' | 'signUpWithEmail' | 'sendPasswordReset'>;
type Mode = 'sign-in' | 'sign-up' | 'reset';

interface SignInDialogProps {
  /** Firebase is loaded: the Google button can open its popup straight from the click. */
  ready: boolean;
  /** Firebase could not be downloaded. The email form still tries again on submit. */
  failed: boolean;
  /** Downloads Firebase again, after `failed`. */
  onRetry: () => void;
  /** Must be called synchronously from the click - see AuthSession.signInWithGoogle. */
  onGoogle: () => Promise<void>;
  /** Email and password open no popup, so these may wait for Firebase to load. */
  emailAuth: EmailAuth;
  onClose: () => void;
}

const MODES: { value: Exclude<Mode, 'reset'>; label: string }[] = [
  { value: 'sign-in', label: 'Sign in' },
  { value: 'sign-up', label: 'Create Account' },
];

const SUBMIT: Record<Mode, { idle: string; pending: string }> = {
  'sign-in': { idle: 'Sign in', pending: 'Signing in...' },
  'sign-up': { idle: 'Create Account', pending: 'Creating your Account...' },
  reset: { idle: 'Send reset link', pending: 'Sending...' },
};

/**
 * The sign-in dialog, on the shared Modal. Each way to sign in is its own
 * section, each with its own pending and error state: Google first, then email
 * and password, which can sign in, create an Account, or send a reset link.
 * Success needs no step here - the Account store closes the dialog once
 * Firebase reports the user.
 */
export function SignInDialog({ ready, failed, onRetry, onGoogle, emailAuth, onClose }: SignInDialogProps) {
  const titleId = useId();
  const googleErrorId = useId();
  const googleFailedId = useId();
  const emailErrorId = useId();
  const passwordHintId = useId();

  const [googlePending, setGooglePending] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailPending, setEmailPending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);

  const busy = googlePending || emailPending;

  // Where focus goes after the next render (a field that just appeared or got filled).
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const focusNext = useRef<'email' | 'password' | null>(null);
  useEffect(() => {
    if (!focusNext.current) return;
    (focusNext.current === 'email' ? emailInput : passwordInput).current?.focus();
    focusNext.current = null;
  });

  const switchMode = (next: Mode, focus?: 'email' | 'password') => {
    setMode(next);
    setEmailError(null);
    setResetSentTo(null);
    if (focus) focusNext.current = focus;
  };
  // What the Learner clicks. Switching while a request runs would show its answer under the wrong form.
  const pickMode = (next: Mode, focus?: 'email' | 'password') => {
    if (!busy) switchMode(next, focus);
  };

  const continueWithGoogle = () => {
    if (busy || !ready) return;
    setGoogleError(null);
    setGooglePending(true);
    // No await before this call: the popup has to open inside the click.
    onGoogle().then(onClose, (reason: unknown) => {
      setGooglePending(false);
      setGoogleError(signInErrorMessage(reason, 'google'));
      // This email has a password Account: fill the form below and put the cursor on the password.
      const clashEmail = emailFromSignInError(reason);
      if (clashEmail) {
        setEmail(clashEmail);
        switchMode('sign-in', 'password');
      }
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const address = email.trim();
    setEmailError(null);
    setGoogleError(null);
    setEmailPending(true);

    if (mode === 'reset') {
      setResetSentTo(null);
      const sent = () => {
        setEmailPending(false);
        setResetSentTo(address);
      };
      emailAuth.sendPasswordReset(address).then(sent, (reason: unknown) => {
        const message = passwordResetErrorMessage(reason);
        if (!message) return sent();
        setEmailPending(false);
        setEmailError(message);
      });
      return;
    }

    const run = mode === 'sign-up' ? emailAuth.signUpWithEmail : emailAuth.signInWithEmail;
    run(address, password).then(onClose, (reason: unknown) => {
      setEmailPending(false);
      setEmailError(signInErrorMessage(reason, mode));
    });
  };

  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      className="items-start justify-center overflow-y-auto bg-black/50 px-4 pb-4 pt-[12vh] backdrop-blur-sm short:pt-4"
      panelClassName="w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated text-brand">
            <UserRound className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-ink">
              Sign in
            </h2>
            <p className="mt-0.5 text-xs text-muted">Optional. Every page works the same without an Account.</p>
          </div>
        </div>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close" className="-mr-2 -mt-1 shrink-0">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-4 px-5 py-5">
        <section aria-label="Sign in with Google">
          <Button
            variant="secondary"
            onClick={continueWithGoogle}
            // aria-disabled, not disabled: a disabled button drops focus out of the Modal.
            aria-disabled={!ready || googlePending}
            aria-describedby={googleError ? googleErrorId : failed ? googleFailedId : undefined}
            className={cn('w-full justify-center', !ready && 'cursor-not-allowed opacity-60')}
          >
            {!failed && (!ready || googlePending) ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <GoogleMark />
            )}
            {failed ? 'Continue with Google' : !ready ? 'Loading sign-in...' : googlePending ? 'Waiting for Google...' : 'Continue with Google'}
          </Button>
          {failed ? (
            <div role="alert" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span id={googleFailedId} className="text-warn">
                Sign-in could not load. Check your connection.
              </span>
              <button type="button" onClick={onRetry} className="rounded font-medium text-brand hover:underline">
                Try again
              </button>
            </div>
          ) : null}
          {googlePending ? (
            <p className="mt-2 text-xs text-muted">Finish in the Google window. Closing it cancels.</p>
          ) : null}
          {googleError ? (
            <p id={googleErrorId} role="alert" className="mt-2 text-xs text-danger">
              {googleError}
            </p>
          ) : null}
        </section>

        <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
          <span className="h-px flex-1 bg-line" />
          or with email
          <span className="h-px flex-1 bg-line" />
        </div>

        <section aria-label="Sign in with email and password" className="space-y-3">
          {mode === 'reset' ? (
            <div>
              <h3 className="text-sm font-semibold text-ink">Reset your password</h3>
              <p className="mt-0.5 text-xs text-muted">We email you a link to choose a new password.</p>
            </div>
          ) : (
            <SegmentedControl
              fill
              value={mode}
              options={MODES}
              onChange={(next) => pickMode(next)}
              className="w-full"
            />
          )}

          <form onSubmit={submit} aria-busy={emailPending} className="space-y-3">
            <Field
              ref={emailInput}
              label="Email"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />

            {mode === 'reset' ? null : (
              <Field
                ref={passwordInput}
                label="Password"
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={mode === 'sign-up' ? 6 : undefined}
                aria-describedby={mode === 'sign-up' ? passwordHintId : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                hint={mode === 'sign-up' ? { id: passwordHintId, text: 'At least 6 characters.' } : undefined}
                trailing={
                  <button
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((shown) => !shown)}
                    className="absolute inset-y-0 right-0 rounded-r-xl px-3 text-xs font-medium text-muted hover:text-ink"
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                }
              />
            )}

            {emailError ? (
              <p id={emailErrorId} role="alert" className="text-xs text-danger">
                {emailError}
              </p>
            ) : null}
            {resetSentTo ? (
              <p role="status" className="flex items-start gap-2 text-xs text-ink">
                {/* The icon carries the ok color; the sentence stays in ink, readable in both themes. */}
                <CircleCheck className="mt-px h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
                <span className="min-w-0">
                  If an Account uses <span className="break-all">{resetSentTo}</span>, a link to set a new password is
                  on its way. Check the inbox, and the spam folder.
                </span>
              </p>
            ) : null}

            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              // aria-disabled, not disabled: a disabled button drops focus out of the Modal.
              aria-disabled={busy}
              aria-describedby={emailError ? emailErrorId : undefined}
            >
              {emailPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {emailPending ? SUBMIT[mode].pending : SUBMIT[mode].idle}
            </Button>
          </form>

          {mode === 'sign-up' ? (
            <p className="text-xs text-muted">
              We email you a link to confirm the address - it may land in spam. Your Account saves progress before you click it.
            </p>
          ) : null}

          {mode === 'sign-in' ? (
            <button
              type="button"
              onClick={() => pickMode('reset', 'email')}
              className="rounded text-xs font-medium text-brand hover:underline"
            >
              Forgot password?
            </button>
          ) : null}
          {mode === 'reset' ? (
            <button
              type="button"
              onClick={() => pickMode('sign-in', 'password')}
              className="rounded text-xs font-medium text-brand hover:underline"
            >
              Back to sign in
            </button>
          ) : null}
        </section>
      </div>
    </Modal>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: { id: string; text: string };
  /** A control drawn inside the right end of the input (the Show password button). */
  trailing?: ReactNode;
}

/** A labelled text input. 16px text on a touch screen, so iOS does not zoom in when it takes focus. */
const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, trailing, className, ...input },
  ref,
) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={id}
          className={cn(
            'h-10 w-full rounded-xl border border-field bg-canvas px-3 text-sm text-ink placeholder:text-faint coarse:text-base',
            'focus:border-brand/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-0',
            trailing ? 'pr-16' : null,
            className,
          )}
          {...input}
        />
        {trailing}
      </div>
      {hint ? (
        <p id={hint.id} className="mt-1 text-xs text-muted">
          {hint.text}
        </p>
      ) : null}
    </div>
  );
});

/** A monochrome "G", drawn in the text color - no brand hex values, no image request. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
      <path d="M21.35 11.1H12v2.98h5.35c-.23 1.45-1.66 4.25-5.35 4.25-3.22 0-5.85-2.67-5.85-5.96S8.78 6.41 12 6.41c1.83 0 3.06.78 3.76 1.45l2.57-2.47C16.68 3.85 14.54 2.9 12 2.9 6.97 2.9 2.9 6.97 2.9 12s4.07 9.1 9.1 9.1c5.25 0 8.74-3.69 8.74-8.89 0-.6-.07-1.05-.15-1.51z" />
    </svg>
  );
}

export default SignInDialog;
