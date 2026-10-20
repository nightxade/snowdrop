import { Check, ImageOff, SmilePlus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import type { CustomEmoji } from '@/core/stores/customEmoji';
import type { ConversationId, CustomEmojiDelivery } from '@/core/domain';
import { createLogger } from '@/core/lib';
import { useCustomEmojiLibrary } from '@/ui/hooks';
import { Button, Skeleton } from '@/ui/primitives';
import { imagePayload, suggestEmojiName } from './emojiImage';
import { useReceivedEmoji } from './useReceivedEmoji';
import styles from './CustomEmojiCard.module.css';

const log = createLogger('ui');

const PROBLEM_TEXT = {
  'too-large': 'This emoji is over 256 KB, so it can’t be added.',
  type: 'This image isn’t a PNG, JPEG, GIF or WebP, so it can’t be added.',
  dimensions: 'This emoji is larger than 1024 × 1024 pixels, so it can’t be added.',
  unreadable: 'This image couldn’t be read, so it can’t be added.',
} as const;

export interface CustomEmojiCardProps {
  conversationId: ConversationId;
  delivery: CustomEmojiDelivery;
}

const imageNamed = (emojis: readonly CustomEmoji[], name: string) =>
  emojis.find((e) => e.name === name);

/**
 * One custom emoji someone else delivered, with what adding it to the
 * viewer's own collection would do: add it, say it's already there (the
 * same image, under this or another name), or — when a different emoji
 * already has that name — offer a rename. Never overwrites. The image goes
 * through the same size/type/dimension checks as one picked in Settings,
 * and nothing leaves this device.
 */
export function CustomEmojiCard({ conversationId, delivery }: CustomEmojiCardProps) {
  const { name } = delivery;
  const library = useCustomEmojiLibrary();
  const [attempt, setAttempt] = useState(0);
  const image = useReceivedEmoji(conversationId, delivery.attachment, attempt);
  const [addedAs, setAddedAs] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const nameId = useId();
  const hintId = useId();

  const dataUrl = image.status === 'ready' ? image.dataUrl : undefined;
  const same =
    dataUrl === undefined
      ? undefined
      : library.emojis.find(
          (e) => e.kind === 'image' && imagePayload(e.dataUrl) === imagePayload(dataUrl),
        );
  const clash = imageNamed(library.emojis, name);
  const taken = (n: string) => imageNamed(library.emojis, n) !== undefined;

  type View = 'loading' | 'unavailable' | 'invalid' | 'added' | 'have' | 'rename' | 'add';
  let view: View;
  if (addedAs !== null) view = 'added';
  else if (image.status === 'error') view = 'unavailable';
  else if (image.status === 'invalid') view = 'invalid';
  else if (image.status !== 'ready') view = 'loading';
  else if (same) view = 'have';
  else if (clash) view = 'rename';
  else view = 'add';

  // Once an action exists, focus its control (the card opens while the image
  // is still being read).
  useEffect(() => {
    if (view !== 'add' && view !== 'rename') return;
    const active = document.activeElement;
    const idle =
      !active ||
      active === document.body ||
      active === root.current ||
      active.getAttribute('role') === 'dialog';
    if (idle)
      root.current
        ?.querySelector<HTMLElement>('[data-card-primary]')
        ?.focus({ preventScroll: true });
  }, [view]);

  const renaming = candidate ?? suggestEmojiName(name, taken);
  const renameProblem = view === 'rename' ? library.nameProblem(renaming) : null;
  const target = view === 'rename' ? renaming : name;

  const add = (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (dataUrl === undefined || (view !== 'add' && view !== 'rename')) return;
    setError(null);
    try {
      library.saveImage(target, dataUrl);
      setAddedAs(target);
    } catch (e) {
      log.warn('adding a received emoji failed', { kind: e instanceof Error ? e.name : 'unknown' });
      setError(e instanceof Error ? e.message : 'Could not add this emoji.');
    }
  };

  return (
    <div
      ref={root}
      className={styles.card}
      data-snowdrop="custom-emoji-card"
      role="group"
      aria-label={`Custom emoji :${name}:`}
      tabIndex={-1}
    >
      <div className={styles.head}>
        <span className={styles.preview}>
          {dataUrl ? (
            <img src={dataUrl} alt="" draggable={false} />
          ) : view === 'loading' ? (
            <Skeleton width="100%" height="100%" radius="sm" />
          ) : (
            <ImageOff className={styles.noImage} aria-hidden />
          )}
        </span>
        <code className={styles.token}>:{name}:</code>
      </div>

      {view === 'loading' && (
        <p className={styles.note} role="status">
          Checking image…
        </p>
      )}
      {view === 'unavailable' && (
        <div className={styles.stack}>
          <p className={styles.note} role="alert">
            Couldn’t load this emoji.
          </p>
          <Button
            size="sm"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {view === 'invalid' && image.status === 'invalid' && (
        <p className={styles.note} role="status">
          {PROBLEM_TEXT[image.problem]}
        </p>
      )}
      {view === 'have' && same && (
        <p className={styles.done} role="status">
          <Check aria-hidden />
          {same.name === name ? 'Already in your emoji' : `Already in your emoji as :${same.name}:`}
        </p>
      )}
      {view === 'added' && addedAs !== null && (
        <p className={styles.done} role="status">
          <Check aria-hidden />
          Added. Type :{addedAs}: to use it.
        </p>
      )}
      {view === 'add' && (
        <div className={styles.stack}>
          <Button
            variant="primary"
            size="sm"
            icon={<SmilePlus />}
            data-card-primary=""
            onClick={() => {
              add();
            }}
          >
            Add to my emoji
          </Button>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {view === 'rename' && (
        <form className={styles.stack} onSubmit={add}>
          <p className={styles.note} role="status">
            You already have a different :{name}:. Add this one under another name.
          </p>
          <label className={styles.label} htmlFor={nameId}>
            Name
          </label>
          <input
            id={nameId}
            className={styles.input}
            data-card-primary=""
            value={renaming}
            maxLength={32}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            aria-invalid={renameProblem ? true : undefined}
            aria-describedby={hintId}
            onChange={(e) => {
              setCandidate(e.target.value.toLowerCase());
              setError(null);
            }}
          />
          <p
            id={hintId}
            className={renameProblem || error ? styles.error : styles.hint}
            role={renameProblem || error ? 'alert' : undefined}
          >
            {error ?? renameProblem ?? '1–32 lowercase letters, numbers, +, - or _.'}
          </p>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<SmilePlus />}
            disabled={renameProblem !== null}
          >
            {renameProblem ? 'Add to my emoji' : `Add as :${renaming}:`}
          </Button>
        </form>
      )}
    </div>
  );
}
