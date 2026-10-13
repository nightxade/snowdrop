import { useRef, useState } from 'react';
import { CUSTOM_EMOJI_TEXT_MAX_LENGTH } from '@/core/stores/customEmoji';
import { useCustomEmojiLibrary } from '@/ui/hooks';
import { Button, IconButton, Segmented } from '@/ui/primitives';
import { Trash2 } from 'lucide-react';
import styles from './CustomEmojiPanel.module.css';

/** `insert` is what should land in the composer: `:name: ` for an image, the text itself for a text emoticon. */
export function CustomEmojiPanel({ onSelect }: { onSelect: (insert: string) => void }) {
  const { emojis, busy, addImage, addText, remove } = useCustomEmojiLibrary();
  const [mode, setMode] = useState<'image' | 'text'>('image');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
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

  const filtered = emojis.filter((emoji) => emoji.name.includes(query.toLowerCase()));

  return (
    <section className={styles.panel} aria-label="My emoji">
      <p className={styles.hint}>
        Your collection on this device. An image inserts :name:; a text emoticon inserts its text.
      </p>
      <input
        className={styles.input}
        aria-label="Find a custom emoji"
        placeholder="Find your emoji"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
      />
      <div className={styles.list}>
        {emojis.length === 0 && (
          <p className={styles.hint}>
            Add an image or text emoticon below to make your first emoji.
          </p>
        )}
        {emojis.length > 0 && filtered.length === 0 && (
          <p className={styles.hint}>No matching emoji.</p>
        )}
        {filtered.map((emoji) => (
          <div className={styles.item} key={emoji.name}>
            <button
              type="button"
              className={styles.emoji}
              aria-label={
                emoji.kind === 'image' ? `Insert :${emoji.name}:` : `Insert ${emoji.text}`
              }
              title={emoji.kind === 'image' ? `:${emoji.name}:` : `${emoji.text} (:${emoji.name}:)`}
              onClick={() => {
                onSelect(emoji.kind === 'image' ? `:${emoji.name}: ` : `${emoji.text} `);
              }}
            >
              {emoji.kind === 'image' ? (
                <img src={emoji.dataUrl} alt="" />
              ) : (
                <span className={styles.textEmoji}>{emoji.text}</span>
              )}
            </button>
            {manage && (
              <IconButton
                label={`Remove :${emoji.name}:`}
                icon={<Trash2 />}
                onClick={() => {
                  remove(emoji.name);
                }}
              />
            )}
          </div>
        ))}
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.add}>
        <Segmented
          label="Emoji kind"
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
        <div className={styles.addRow}>
          <input
            className={styles.input}
            aria-label="Custom emoji name"
            placeholder="emoji_name"
            maxLength={32}
            value={name}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value.toLowerCase());
            }}
          />
          {mode === 'image' ? (
            <>
              <Button size="sm" disabled={busy || !name} onClick={() => fileInput.current?.click()}>
                {busy ? 'Adding…' : 'Add image'}
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
            </>
          ) : (
            <Button size="sm" disabled={!name || text.trim() === ''} onClick={onAddText}>
              Add text
            </Button>
          )}
        </div>
        {mode === 'text' && (
          <input
            className={styles.input}
            aria-label="Emoticon text"
            placeholder="¯\_(ツ)_/¯"
            maxLength={CUSTOM_EMOJI_TEXT_MAX_LENGTH}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        )}
      </div>
      <div className={styles.footer}>
        <span className={styles.hint}>
          {mode === 'image'
            ? 'Up to 256 KB and 1024 × 1024 pixels'
            : `Up to ${CUSTOM_EMOJI_TEXT_MAX_LENGTH} characters, no line breaks`}
        </span>
        {emojis.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setManage(!manage);
            }}
          >
            {manage ? 'Done' : 'Manage'}
          </Button>
        )}
      </div>
    </section>
  );
}
