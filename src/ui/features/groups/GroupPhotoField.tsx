import { ImagePlus } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { initialsFor, type ConversationId } from '@/core/domain';
import { useAvatarSrc } from '@/ui/hooks';
import { AVATAR_ACCEPT, prepareAvatar } from '@/ui/lib/avatarImage';
import { Avatar, Button } from '@/ui/primitives';
import styles from './groups.module.css';

/** A photo staged in a form, as the `data:` URI that goes to the backend. */
export interface StagedPhoto {
  dataUri: string;
}

/**
 * The group photo in a form: the current or newly picked image, and a button
 * to pick another (cropped to a square and shrunk the way a profile photo is).
 * Signal has no way to take a group's photo away again, so there is no remove.
 */
export function GroupPhotoField({
  name,
  color,
  groupId,
  avatarVersion,
  current,
  staged,
  onStage,
  onProblem,
  disabled,
}: {
  name: string;
  color: string;
  /** The group being edited: its stored photo is fetched, so it shows after a restart too. */
  groupId?: ConversationId | undefined;
  avatarVersion?: number | undefined;
  /** A photo the app already holds for the group (set in this session), shown until the stored one arrives. */
  current?: string | undefined;
  staged: StagedPhoto | null;
  onStage: (photo: StagedPhoto) => void;
  /** Called with a sentence when the picked file can't be used; null clears it. */
  onProblem: (message: string | null) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [ref, fetched] = useAvatarSrc('group', groupId, { version: avatarVersion, known: current });
  const shown = staged?.dataUri ?? fetched;

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setReading(true);
    onProblem(null);
    try {
      const prepared = await prepareAvatar(file);
      onStage({ dataUri: `data:${prepared.contentType};base64,${prepared.base64}` });
    } catch {
      onProblem("Couldn't read that image. Pick a JPEG, PNG, GIF or WebP file.");
    } finally {
      setReading(false);
    }
  };

  return (
    <div className={styles.photo}>
      <Avatar
        ref={ref}
        size={80}
        shape="rounded"
        {...(shown ? { src: shown } : {})}
        fallback={initialsFor(name || '?')}
        color={color}
      />
      <div className={styles.photoActions}>
        <Button
          size="sm"
          icon={<ImagePlus size={14} />}
          disabled={(disabled ?? false) || reading}
          onClick={() => input.current?.click()}
        >
          {shown ? 'Change photo' : 'Add photo'}
        </Button>
        <input
          ref={input}
          type="file"
          accept={AVATAR_ACCEPT}
          hidden
          tabIndex={-1}
          aria-label="Choose a group photo"
          onChange={(e) => void pick(e)}
        />
      </div>
    </div>
  );
}
