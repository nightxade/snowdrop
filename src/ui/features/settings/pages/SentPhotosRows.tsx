import { describeFailure } from '@/ui/lib/connectionErrors';
import { ImageDown, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SentOriginalsUsage } from '@/core/persistence';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal, Select, type SelectOption } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { formatBytes } from './formatBytes';
import styles from './pages.module.css';

type Age = '30d' | '90d' | '1y' | 'all';

const DAY_MS = 24 * 60 * 60 * 1000;

const AGES: readonly (SelectOption<Age> & { days: number; phrase: string })[] = [
  { value: '30d', label: 'Older than 30 days', days: 30, phrase: 'more than 30 days ago' },
  { value: '90d', label: 'Older than 90 days', days: 90, phrase: 'more than 90 days ago' },
  { value: '1y', label: 'Older than a year', days: 365, phrase: 'more than a year ago' },
  { value: 'all', label: 'All of them', days: 0, phrase: 'at any time' },
];

const photos = (n: number): string => `${n.toLocaleString()} photo${n === 1 ? '' : 's'}`;

type Phase =
  | { step: 'idle' }
  | { step: 'checking'; percent: number }
  | { step: 'confirm'; age: Age; usage: SentOriginalsUsage }
  | { step: 'freeing'; percent: number };

/**
 * Settings → Data & storage: how much room the full-quality copies of your
 * sent photos take, and a way to remove the older ones. Nothing is removed
 * unless you confirm it here.
 */
export function SentPhotosRows() {
  const app = useSnowdrop();
  const [usage, setUsage] = useState<SentOriginalsUsage | 'unavailable' | null>(null);
  const [age, setAge] = useState<Age>('90d');
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [result, setResult] = useState<{ text: string; tone: 'success' | 'danger' } | null>(null);
  const alive = useRef(new AbortController());
  const selectRef = useRef<HTMLSelectElement>(null);
  const lastStep = useRef<Phase['step']>('idle');

  const measure = async () => {
    try {
      setUsage(await app.admin.sentOriginalsUsage());
    } catch {
      setUsage('unavailable');
    }
  };

  useEffect(() => {
    // StrictMode runs this twice: a fresh controller each time the page opens.
    const controller = new AbortController();
    alive.current = controller;
    void (async () => {
      try {
        const next = await app.admin.sentOriginalsUsage();
        if (!controller.signal.aborted) setUsage(next);
      } catch {
        if (!controller.signal.aborted) setUsage('unavailable');
      }
    })();
    return () => {
      controller.abort();
    };
  }, [app]);

  const scopeFor = (choice: Age, onPercent: (percent: number) => void) => {
    const days = AGES.find((a) => a.value === choice)?.days ?? 0;
    return {
      olderThan: choice === 'all' ? Infinity : Date.now() - days * DAY_MS,
      signal: alive.current.signal,
      onProgress: (done: number, total: number) => {
        onPercent(total === 0 ? 100 : Math.round((done / total) * 100));
      },
    };
  };

  const start = async () => {
    setResult(null);
    setPhase({ step: 'checking', percent: 0 });
    try {
      const found = await app.admin.sentOriginalsUsage(
        scopeFor(age, (percent) => {
          setPhase({ step: 'checking', percent });
        }),
      );
      if (alive.current.signal.aborted) return;
      if (found.photos === 0) {
        const label = AGES.find((a) => a.value === age)?.label.toLowerCase() ?? '';
        setResult({
          text: age === 'all' ? 'There are none to free up.' : `None ${label}.`,
          tone: 'success',
        });
        setPhase({ step: 'idle' });
        return;
      }
      setPhase({ step: 'confirm', age, usage: found });
    } catch (error) {
      if (alive.current.signal.aborted) return;
      setResult({ text: failure(error), tone: 'danger' });
      setPhase({ step: 'idle' });
    }
  };

  const confirm = async (choice: Age) => {
    setPhase({ step: 'freeing', percent: 0 });
    try {
      const dropped = await app.admin.dropSentOriginals(
        scopeFor(choice, (percent) => {
          setPhase({ step: 'freeing', percent });
        }),
      );
      if (alive.current.signal.aborted) return;
      setResult({
        text:
          dropped.photos === 0
            ? 'Nothing was left to free up.'
            : `Freed ${formatBytes(dropped.bytes)} from ${photos(dropped.photos)}.`,
        tone: 'success',
      });
    } catch (error) {
      if (alive.current.signal.aborted) return;
      setResult({ text: failure(error), tone: 'danger' });
    }
    setPhase({ step: 'idle' });
    await measure();
  };

  useEffect(() => {
    // A run that ends without a dialog leaves the disabled button's focus nowhere: put it back.
    if (
      phase.step === 'idle' &&
      (lastStep.current === 'checking' || lastStep.current === 'freeing')
    )
      selectRef.current?.focus();
    lastStep.current = phase.step;
  }, [phase.step]);

  const busy = phase.step === 'checking' || phase.step === 'freeing';
  const none = usage !== null && usage !== 'unavailable' && usage.photos === 0;
  const progress = phase.step === 'checking' || phase.step === 'freeing' ? phase.percent : null;

  return (
    <>
      <SettingRow
        id="data.sentPhotos"
        label="Full-quality sent photos"
        description={
          usage === null
            ? 'Measuring…'
            : usage === 'unavailable'
              ? 'Not available here.'
              : usage.photos === 0
                ? 'None'
                : formatBytes(usage.bytes)
        }
      />
      <SettingRow
        id="data.freeUp"
        label="Free up space"
        description="Removes the full-quality copies of photos you sent. They stay in your chats at preview quality. Photos you send later are kept in full again."
        note={result?.text}
        noteTone={result?.tone ?? 'info'}
        control={
          <span className={styles.inlineControls}>
            <Select<Age>
              ref={selectRef}
              aria-label="Photos to free up"
              value={age}
              options={AGES}
              disabled={busy || none}
              onValueChange={(next) => {
                setAge(next);
                setResult(null);
              }}
            />
            <Button
              icon={
                busy ? <LoaderCircle size={16} className={styles.spin} /> : <ImageDown size={16} />
              }
              disabled={busy || none || usage === null}
              onClick={() => {
                void start();
              }}
            >
              {phase.step === 'checking'
                ? 'Checking…'
                : phase.step === 'freeing'
                  ? 'Freeing…'
                  : 'Free up…'}
            </Button>
          </span>
        }
      >
        {progress !== null && (
          <div
            className={styles.meter}
            role="progressbar"
            aria-label={phase.step === 'checking' ? 'Checking your messages' : 'Freeing up space'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <span style={{ width: `${Math.max(1, progress)}%` }} />
          </div>
        )}
      </SettingRow>
      {phase.step === 'confirm' && (
        <Modal
          open
          size="sm"
          returnFocus={() => selectRef.current}
          onOpenChange={(open) => {
            if (!open) setPhase({ step: 'idle' });
          }}
          title={`Free up ${formatBytes(phase.usage.bytes)}?`}
          description={`This removes the full-quality copies of ${photos(phase.usage.photos)} you sent ${AGES.find((a) => a.value === phase.age)?.phrase ?? ''}. They will show at preview quality from now on, everywhere in Snowdrop. It can't be undone.`}
          footer={
            <>
              <Button
                variant="ghost"
                data-autofocus
                onClick={() => {
                  setPhase({ step: 'idle' });
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void confirm(phase.age);
                }}
              >
                Free up space
              </Button>
            </>
          }
        />
      )}
    </>
  );
}

function failure(error: unknown): string {
  return `Couldn’t free up space: ${describeFailure(error)}`;
}
