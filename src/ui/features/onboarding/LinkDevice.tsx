import { CircleCheck, LoaderCircle, QrCode as QrIcon, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { LinkFlow } from '@/core/backend';
import { Button, TextInput } from '@/ui/primitives';
import { QrCode } from '@/ui/primitives/QrCode';
import { MAX_DEVICE_NAME } from './linkFlow';
import { useLinkFlow } from './useLinkFlow';
import styles from './Setup.module.css';

export interface LinkDeviceProps {
  link: LinkFlow | undefined;
  /** Linking finished; the app reconnects with the new account. */
  onLinked: (accountId: string) => void;
}

/**
 * Link this browser to a Signal account as a secondary device: a QR code
 * from signal-cli, scanned in the Signal app (PLAN §4.10).
 */
export function LinkDevice({ link, onLinked }: LinkDeviceProps) {
  const flow = useLinkFlow(link, onLinked);
  const { state } = flow;
  const busy = state.step === 'starting' || state.step === 'waiting';
  const retryRef = useRef<HTMLButtonElement>(null);
  // A failure moves focus to "Get a new code", the one thing to do next.
  useEffect(() => {
    if (state.step === 'failed') retryRef.current?.focus();
  }, [state.step]);

  return (
    <section className={styles.card} aria-labelledby="link-title" data-snowdrop="link-device">
      <h2 id="link-title" className={styles.title}>
        Link Snowdrop to your phone
      </h2>
      <p className={styles.lede}>
        signal-cli is running but has no account yet. Link it to the Signal account on your phone,
        the same way you’d add Signal Desktop. Your phone stays the main device.
      </p>
      <div className={styles.linkBody}>
        <div className={styles.qrFrame} data-step={state.step} aria-live="polite">
          {state.step === 'waiting' ? (
            <QrCode
              value={state.uri}
              size={208}
              label="QR code to scan with the Signal app on your phone"
            />
          ) : state.step === 'starting' ? (
            <span className={styles.qrPlaceholder}>
              <LoaderCircle className={styles.spin} size={28} aria-hidden />
              Getting a code…
            </span>
          ) : state.step === 'linked' ? (
            <span className={styles.qrPlaceholder} data-tone="success">
              <CircleCheck size={32} aria-hidden />
              Linked
            </span>
          ) : state.step === 'failed' ? (
            <span className={styles.qrPlaceholder} data-tone="danger">
              <TriangleAlert size={28} aria-hidden />
              {state.expired ? 'Code expired' : 'Linking failed'}
            </span>
          ) : (
            <span className={styles.qrPlaceholder}>
              <QrIcon size={28} aria-hidden />
              Your code appears here
            </span>
          )}
        </div>
        <div className={styles.linkSide}>
          <ol className={styles.steps}>
            <li>Open Signal on your phone.</li>
            <li>
              Go to <strong>Settings → Linked devices → Link new device</strong>.
            </li>
            <li>Point your phone at the code. Keep this tab open until it finishes.</li>
          </ol>
          {state.step === 'naming' || state.step === 'failed' ? (
            <form
              className={styles.nameForm}
              onSubmit={(e) => {
                e.preventDefault();
                flow.start();
              }}
            >
              <TextInput
                autoFocus={state.step === 'naming'}
                label="Device name"
                hint="Shown in Signal’s list of linked devices."
                value={state.deviceName}
                maxLength={MAX_DEVICE_NAME}
                onChange={(e) => {
                  flow.rename(e.target.value);
                }}
              />
              <Button
                ref={retryRef}
                type="submit"
                variant="primary"
                disabled={!flow.supported || !state.deviceName.trim()}
                icon={state.step === 'failed' ? <RotateCw size={16} /> : undefined}
              >
                {state.step === 'failed' ? 'Get a new code' : 'Show code'}
              </Button>
            </form>
          ) : state.step === 'linked' ? (
            <p className={styles.status} data-tone="success" role="status">
              <CircleCheck size={16} aria-hidden />
              Linked as {state.deviceName}. Loading your conversations…
            </p>
          ) : (
            <div className={styles.waiting}>
              <p className={styles.status} role="status">
                <LoaderCircle className={styles.spin} size={16} aria-hidden />
                {state.step === 'starting'
                  ? 'Asking signal-cli for a code…'
                  : 'Waiting for your phone…'}
              </p>
              <p className={styles.muted}>
                Linking as <strong>{state.deviceName}</strong>.{' '}
                <button
                  type="button"
                  className={styles.inlineLink}
                  onClick={flow.edit}
                  disabled={!busy}
                >
                  Change name
                </button>
              </p>
            </div>
          )}
          {state.step === 'failed' && (
            <p className={styles.error} role="alert">
              {state.expired
                ? 'The code wasn’t scanned in time. Get a new one and scan it within a minute or two.'
                : `signal-cli said: ${state.message}`}
            </p>
          )}
          {!flow.supported && (
            <p className={styles.error} role="alert">
              This backend can’t link devices.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
