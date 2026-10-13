import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { CUSTOM_EMOJI_TEXT_MAX_LENGTH } from '@/core/stores/customEmoji';
import { useCustomEmojiLibrary } from '@/ui/hooks';
import { Button, IconButton, Segmented } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import styles from './pages.module.css';

const MAX_EMOJI = 32;

/**
 * Settings → Custom emoji: the same add/validate/remove logic as the
 * composer's "My emoji" tab (useCustomEmojiLibrary), surfaced somewhere
 * people actually look for it rather than only inside the emoji picker.
 * Two kinds share the form: an image (uploaded, delivered to recipients) or
 * a text emoticon (typed here, sent as plain text — nothing to deliver).
 */
export function CustomEmojiPage() {
  const { emojis, busy, addImage, addText, remove } = useCustomEmojiLibrary();
  const [mode, setMode] = useState<'image' | 'text'>('image');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const onAddImage = async (file: File) => {
    setError(null);
    try {
      await addImage(name, file);
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add this emoji.');
    }
  };

  const onAddText = () => {
    setError(null);
    try {
      addText(name, text);
      setName('');
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add this emoticon.');
    }
  };

  return (
    <>
      <SettingsSection
        title="Add an emoji"
        description="Type :name: in the composer, or pick it from the emoji picker's “My emoji” tab."
      >
        <SettingRow
          id="customEmoji.kind"
          label="Kind"
          control={(ids) => (
            <Segmented
              labelledBy={ids.labelId}
              label="Kind"
              value={mode}
              options={[
                { value: 'image', label: 'Image' },
                { value: 'text', label: 'Text' },
              ]}
              onValueChange={(v) => {
                setMode(v);
                setError(null);
              }}
            />
          )}
        />
        <SettingRow
          id="customEmoji.name"
          label="Name"
          description="1–32 lowercase letters, numbers, +, - or _."
          control={(ids) => (
            <input
              id={ids.id}
              aria-describedby={ids.descriptionId}
              className={styles.emojiNameInput}
              placeholder="emoji_name"
              maxLength={32}
              value={name}
              disabled={busy}
              onChange={(e) => {
                setName(e.target.value.toLowerCase());
              }}
            />
          )}
        />
        {mode === 'image' ? (
          <SettingRow
            id="customEmoji.upload"
            label="Image"
            description="PNG, JPEG, GIF or WebP; up to 256 KB and 1024 × 1024 pixels."
            stacked
            note={error}
            noteTone="danger"
            control={
              <div className={styles.emojiUpload}>
                <Button disabled={busy || !name} onClick={() => fileInput.current?.click()}>
                  {busy ? 'Adding…' : 'Choose image'}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  aria-label="Custom emoji image"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void onAddImage(file);
                  }}
                />
              </div>
            }
          />
        ) : (
          <SettingRow
            id="customEmoji.text"
            label="Text"
            description={`Up to ${CUSTOM_EMOJI_TEXT_MAX_LENGTH} characters, no line breaks. Sent exactly as shown.`}
            stacked
            note={error}
            noteTone="danger"
            control={(ids) => (
              <div className={styles.emojiTextRow}>
                <input
                  id={ids.id}
                  aria-describedby={ids.descriptionId}
                  className={styles.emojiNameInput}
                  placeholder="¯\_(ツ)_/¯"
                  maxLength={CUSTOM_EMOJI_TEXT_MAX_LENGTH}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                  }}
                />
                <span className={styles.emojiTextPreview} aria-hidden>
                  {text.trim() || '—'}
                </span>
                <Button disabled={!name || text.trim() === ''} onClick={onAddText}>
                  Add text emoji
                </Button>
              </div>
            )}
          />
        )}
      </SettingsSection>
      <SettingsSection
        title="Your collection"
        description={
          emojis.length > 0
            ? `${emojis.length} of ${MAX_EMOJI} used.`
            : 'No custom emoji yet — add one above.'
        }
      >
        {emojis.length > 0 && (
          <div className={styles.emojiGrid}>
            {emojis.map((emoji) => (
              <div className={styles.emojiTile} key={emoji.name}>
                {emoji.kind === 'image' ? (
                  <img className={styles.emojiImage} src={emoji.dataUrl} alt="" />
                ) : (
                  <span className={styles.emojiTextTile} title={emoji.text}>
                    {emoji.text}
                  </span>
                )}
                <span className={styles.emojiName}>:{emoji.name}:</span>
                <IconButton
                  label={`Remove :${emoji.name}:`}
                  icon={<Trash2 />}
                  onClick={() => {
                    remove(emoji.name);
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </>
  );
}
