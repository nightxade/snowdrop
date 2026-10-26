import { Copy, ImagePlus, Info, SmilePlus, Trash2, X } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type SubmitEvent } from 'react';
import { useStore } from 'zustand';
import { initialsFor, type Contact } from '@/core/domain';
import { graphemes } from '@/core/lib';
import { sessionSelectors } from '@/core/stores';
import { copyText, formatPhone } from '@/ui/features/conversation';
import { useSnowdrop } from '@/ui/hooks';
import { Avatar, Button, EmojiPickerPopover, IconButton, TextInput } from '@/ui/primitives';
import {
  fieldCounter,
  fitField,
  normalizeDraft,
  sameDraft,
  type ProfileDraft,
  type ProfileField,
} from '../lib/profileFields';
import { AVATAR_ACCEPT, prepareAvatar, type PreparedAvatar } from '@/ui/lib/avatarImage';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import styles from './pages.module.css';

/** The photo staged in the editor: a new one, or `null` for "remove it"; unset keeps the current one. */
type StagedAvatar = { prepared: PreparedAvatar; previewUrl: string } | null | undefined;

function draftFrom(self: Contact): ProfileDraft {
  return {
    givenName: self.profileGivenName ?? self.profileName ?? '',
    familyName: self.profileFamilyName ?? '',
    about: self.about ?? '',
    aboutEmoji: self.aboutEmoji ?? '',
  };
}

function Counter({ text, field }: { text: string; field: ProfileField }) {
  const { remaining, visible, warn } = fieldCounter(text, field);
  if (!visible) return null;
  return (
    <span className={styles.counter} data-warn={warn ? '' : undefined} aria-hidden>
      {remaining}
    </span>
  );
}

export function ProfilePage() {
  const app = useSnowdrop();
  const self = useStore(app.stores.session, sessionSelectors.self);
  const backend = app.backend.kind;
  if (!self) {
    return <p className={styles.muted}>Your profile appears here once Snowdrop has connected.</p>;
  }
  return (
    <SettingsSection>
      <SettingRow id="profile.card" label="Profile" stacked>
        <ProfileEditor self={self} demo={backend === 'mock'} />
      </SettingRow>
      <SettingRow
        id="profile.account"
        label="Account ID"
        description={<code className={styles.code}>{self.id}</code>}
        control={
          <Button
            size="sm"
            icon={<Copy size={14} />}
            onClick={() => {
              void copyText(app, self.id, 'account ID');
            }}
          >
            Copy
          </Button>
        }
      />
    </SettingsSection>
  );
}

function ProfileEditor({ self, demo }: { self: Contact; demo: boolean }) {
  const app = useSnowdrop();
  const saved = draftFrom(self);
  const [draft, setDraft] = useState<ProfileDraft>(saved);
  const [avatar, setAvatar] = useState<StagedAvatar>(undefined);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const firstName = useRef<HTMLInputElement>(null);
  const busy = saving || reading;

  const shownPhoto = avatar === undefined ? self.avatarUrl : avatar?.previewUrl;
  const photoStaged = avatar !== undefined;
  const dirty = photoStaged || !sameDraft(draft, saved);
  const normalized = normalizeDraft(draft);
  const valid = normalized.givenName !== '';

  const edit = (patch: Partial<ProfileDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDone(false);
    setError(null);
  };

  const pickPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setReading(true);
    setError(null);
    setDone(false);
    try {
      const prepared = await prepareAvatar(file);
      setAvatar({
        prepared,
        previewUrl: `data:${prepared.contentType};base64,${prepared.base64}`,
      });
    } catch {
      setError("Couldn't read that image. Pick a JPEG, PNG, GIF or WebP file.");
    } finally {
      setReading(false);
    }
  };

  const discard = () => {
    setDraft(saved);
    setAvatar(undefined);
    setError(null);
    setDone(false);
  };

  const save = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !dirty || !valid) return;
    setSaving(true);
    setError(null);
    setDone(false);
    const failure = await app.sync.updateProfile({
      ...normalized,
      ...(avatar === undefined ? {} : { avatar: avatar?.prepared ?? null }),
    });
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    setAvatar(undefined);
    setDone(true);
    // The Save button is about to disable; keep keyboard focus on the form.
    if (document.activeElement === document.body || document.activeElement?.tagName === 'BUTTON') {
      firstName.current?.focus({ preventScroll: true });
    }
  };

  return (
    <form className={styles.editor} onSubmit={(e) => void save(e)} noValidate>
      <div className={styles.profileHead}>
        <Avatar
          size={80}
          {...(shownPhoto ? { src: shownPhoto } : {})}
          fallback={initialsFor(normalized.givenName || self.name)}
          color={self.color}
        />
        <div className={styles.profileText}>
          {self.number && <p className={styles.muted}>{formatPhone(self.number)}</p>}
          <div className={styles.photoActions}>
            <Button
              size="sm"
              icon={<ImagePlus size={14} />}
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {shownPhoto ? 'Change photo' : 'Add photo'}
            </Button>
            {shownPhoto && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={14} />}
                disabled={busy}
                onClick={() => {
                  setAvatar(null);
                  setDone(false);
                  setError(null);
                }}
              >
                Remove photo
              </Button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={AVATAR_ACCEPT}
            hidden
            tabIndex={-1}
            aria-label="Choose a profile photo"
            onChange={(e) => void pickPhoto(e)}
          />
        </div>
      </div>

      <div className={styles.fields}>
        <TextInput
          ref={firstName}
          label="First name"
          value={draft.givenName}
          required
          aria-required
          autoComplete="off"
          disabled={saving}
          trailing={<Counter text={draft.givenName} field="name" />}
          onChange={(e) => {
            edit({ givenName: fitField(e.target.value, 'name') });
          }}
        />
        <TextInput
          label="Last name"
          value={draft.familyName}
          autoComplete="off"
          disabled={saving}
          trailing={<Counter text={draft.familyName} field="name" />}
          onChange={(e) => {
            edit({ familyName: fitField(e.target.value, 'name') });
          }}
        />
        <TextInput
          label="About"
          value={draft.about}
          autoComplete="off"
          disabled={saving}
          placeholder="Say something about yourself"
          leading={draft.aboutEmoji ? <span>{draft.aboutEmoji}</span> : undefined}
          trailing={
            <>
              <Counter text={draft.about} field="about" />
              {draft.aboutEmoji && (
                <IconButton
                  label="Remove emoji"
                  size="sm"
                  icon={<X size={14} />}
                  disabled={saving}
                  onClick={() => {
                    edit({ aboutEmoji: '' });
                  }}
                />
              )}
              <EmojiPickerPopover
                open={emojiOpen}
                onOpenChange={setEmojiOpen}
                side="bottom"
                onSelect={(emoji) => {
                  // Like Desktop, one emoji goes with the about text.
                  edit({ aboutEmoji: graphemes(emoji)[0] ?? '' });
                  setEmojiOpen(false);
                }}
              >
                <IconButton
                  label={draft.aboutEmoji ? 'Change emoji' : 'Add emoji'}
                  size="sm"
                  icon={<SmilePlus size={14} />}
                  active={emojiOpen}
                  disabled={saving || draft.about === ''}
                />
              </EmojiPickerPopover>
            </>
          }
          onChange={(e) => {
            const about = fitField(e.target.value.replace(/[\r\n]+/gu, ''), 'about');
            edit({ about, ...(about ? {} : { aboutEmoji: '' }) });
          }}
        />
      </div>

      <div className={styles.editorActions}>
        <Button type="submit" variant="primary" disabled={!dirty || !valid || busy}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button disabled={!dirty || busy} onClick={discard}>
          Discard changes
        </Button>
        <p className={styles.editorStatus} role="status">
          {done ? 'Saved.' : reading ? 'Preparing photo…' : ''}
        </p>
      </div>
      {error && (
        <p className={styles.editorError} role="alert">
          {error}
        </p>
      )}
      {!valid && dirty && <p className={styles.hint}>A first name is required.</p>}
      <p className={styles.hint}>
        <Info size={14} aria-hidden />
        {demo
          ? 'This is the demo profile. Changes stay in this demo.'
          : 'Saved to your Signal profile, and your phone is told to pick it up.'}
      </p>
    </form>
  );
}
