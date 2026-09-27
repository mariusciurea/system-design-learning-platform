import { useId, useRef, useState, type FormEvent } from 'react';
import { Loader2, Trash2, TriangleAlert } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { useAccount } from '@/app/providers/AccountProvider';
import { deleteAccountMessage } from './deleteAccountMessages';

interface DeleteAccountDialogProps {
  onClose: () => void;
  /** The Account is gone and this device is an empty Guest. */
  onDeleted: (firebaseUserDeleted: boolean) => void;
}

/**
 * The confirm box of "Delete my Account", on the shared Modal: what is lost,
 * then a new proof that it is the Learner - the Google popup, or the password
 * of a password Account - because Firebase deletes a user only after a recent
 * sign-in. Nothing is deleted until that proof and the server both succeed.
 */
export function DeleteAccountDialog({ onClose, onDeleted }: DeleteAccountDialogProps) {
  const { reauthMethod, deleteAccount } = useAccount();
  const [method] = useState(() => reauthMethod() ?? 'google');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const passwordId = useId();
  const errorId = useId();
  const passwordInput = useRef<HTMLInputElement>(null);

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (method === 'password' && !password) {
      setError('Type your password to confirm. Nothing was deleted.');
      passwordInput.current?.focus();
      return;
    }
    setError(null);
    setPending(true);
    // No await before this call: the Google popup has to open inside the click.
    void deleteAccount(method === 'password' ? password : undefined).then((result) => {
      if (result.ok) {
        onDeleted(result.firebaseUserDeleted);
        return;
      }
      setPending(false);
      setError(deleteAccountMessage(result));
      // A wrong password is the usual cause: put the cursor back where the fix goes.
      if (method === 'password') passwordInput.current?.focus();
    });
  };

  return (
    <Modal
      onClose={pending ? () => undefined : onClose}
      labelledBy={titleId}
      className="items-start justify-center overflow-y-auto bg-black/50 px-4 pb-4 pt-[12vh] backdrop-blur-sm short:pt-4"
      panelClassName="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
    >
      <form onSubmit={confirm}>
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
            <TriangleAlert className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-ink">
              Delete your Account?
            </h2>
            <p className="mt-0.5 text-xs text-muted">This cannot be undone.</p>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <p className="text-sm text-ink">You lose:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              <li>All the progress saved to your Account, on every device.</li>
              <li>The Account itself. Other devices signed in to it become empty Guests.</li>
            </ul>
          </div>

          {method === 'password' ? (
            <div>
              <label htmlFor={passwordId} className="mb-1 block text-xs font-medium text-ink">
                Your password, to confirm it is you
              </label>
              <input
                ref={passwordInput}
                id={passwordId}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                // readOnly and aria-disabled, not disabled: a disabled control drops focus out of the Modal.
                readOnly={pending}
                aria-disabled={pending}
                aria-describedby={error ? errorId : undefined}
                className="h-10 w-full rounded-xl border border-field bg-canvas px-3 text-sm text-ink focus:border-brand/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 coarse:text-base"
              />
            </div>
          ) : (
            <p className="text-xs text-muted">To confirm it is you, Google asks you to sign in once more.</p>
          )}

          {error ? (
            <p id={errorId} role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">
          <Button variant="secondary" onClick={pending ? undefined : onClose} aria-disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" aria-disabled={pending} aria-describedby={error ? errorId : undefined}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
            {pending ? 'Deleting...' : 'Delete my Account'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default DeleteAccountDialog;
