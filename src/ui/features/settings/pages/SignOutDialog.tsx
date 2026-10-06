/**
 * "Sign out…" / "Leave demo…" / "Disconnect…": one dialog for all three
 * flows (docs/ENCRYPTION.md, "Sign out"), picked by `signOutFlowFor` from
 * whatever backend is actually running — not from an unapplied Settings →
 * Connection edit. Shared by the user panel's menu (sidebar bottom-left),
 * Settings → Connection, and the `core.signOut` command, so there's one
 * place that gets the copy and the ordering right.
 */
import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { sessionSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import {
  disconnectExternalDaemon,
  leaveDemo,
  signOutDesktop,
  SignOutRestartFailed,
  signOutFlowFor,
} from './signOutFlow';
import styles from './pages.module.css';

export interface SignOutDialogProps {
  onClose: () => void;
}

export function SignOutDialog({ onClose }: SignOutDialogProps) {
  const app = useSnowdrop();
  const flow = signOutFlowFor(app);
  const self = useStore(app.stores.session, sessionSelectors.self);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set only by `SignOutRestartFailed`: sign-out itself already went
  // through, so from here the only thing left to retry is the restart —
  // never re-offer "Sign out" on an account that's already gone.
  const [restartFailed, setRestartFailed] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      // Every flow either reloads the page or restarts the whole app
      // process on success, so there's nothing left for this component to
      // do — it's about to be torn down either way.
    } catch (e) {
      if (e instanceof SignOutRestartFailed) {
        setRestartFailed(true);
        setError(e.message);
        setBusy(false);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const retryRestart = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.storageAdmin?.restart();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const close = () => {
    // Nothing to cancel back to: the desktop vault is already signed out.
    if (!busy && !restartFailed) onClose();
  };

  if (restartFailed) {
    return (
      <Modal
        open
        size="sm"
        onOpenChange={() => {
          // No dismiss: there's nothing left to go back to.
        }}
        title="Restart Snowdrop to finish"
        description="You're signed out on this computer. Snowdrop needs to restart once before it can be used again."
        footer={
          <Button
            variant="primary"
            icon={busy ? <RotateCw size={16} className={styles.spin} /> : <RotateCw size={16} />}
            autoFocus
            disabled={busy}
            onClick={() => void retryRestart()}
          >
            Restart Snowdrop
          </Button>
        }
      >
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <p className={styles.muted}>
          If this keeps happening, close Snowdrop and reopen it yourself.
        </p>
      </Modal>
    );
  }

  if (flow === 'demo') {
    return (
      <Modal
        open
        size="sm"
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="Leave the demo?"
        description="Snowdrop goes back to the Welcome screen. Your settings, themes and spaces are kept."
        footer={
          <>
            <Button variant="ghost" data-autofocus disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run(() => leaveDemo(app))}
            >
              {busy ? 'Leaving…' : 'Leave demo'}
            </Button>
          </>
        }
      >
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </Modal>
    );
  }

  if (flow === 'browser') {
    return (
      <Modal
        open
        size="sm"
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="Disconnect from signal-cli?"
        description="Snowdrop goes back to the Welcome screen. It never owned this daemon's data, so nothing about it changes."
        footer={
          <>
            <Button variant="ghost" data-autofocus disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void run(() => disconnectExternalDaemon(app))}
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </>
        }
      >
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Sign out of Signal on this computer?"
      description="This removes this computer's Signal keys, contacts and message history. Your Snowdrop settings, themes and spaces stay."
      footer={
        <>
          <Button variant="ghost" data-autofocus disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void run(() => signOutDesktop(app))}
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </Button>
        </>
      }
    >
      <p className={styles.muted}>
        Also remove this computer from your phone: Signal → Settings → Linked devices.
      </p>
      {self?.name && (
        <p className={styles.muted}>
          Currently signed in as <strong className={styles.strong}>{self.name}</strong>.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
