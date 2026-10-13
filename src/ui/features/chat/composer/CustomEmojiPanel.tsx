import { useRef, useState } from 'react';
import { useCustomEmojiLibrary } from '@/ui/hooks';
import { Button, IconButton } from '@/ui/primitives';
import { Trash2 } from 'lucide-react';
import styles from './CustomEmojiPanel.module.css';

export function CustomEmojiPanel({ onSelect }: { onSelect: (name: string) => void }) {
  const { emojis, busy, add, remove } = useCustomEmojiLibrary();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const onAdd = async (file: File) => {
    setError(null);
    try {
      await add(name, file);
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add this emoji.');
    }
  };

  return (
    <section className={styles.panel} aria-label="My emoji">
      <p className={styles.hint}>Your collection on this device. Inserts :name: into the text.</p>
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
          <p className={styles.hint}>Add an image below to make your first emoji.</p>
        )}
        {emojis.length > 0 && !emojis.some((e) => e.name.includes(query.toLowerCase())) && (
          <p className={styles.hint}>No matching emoji.</p>
        )}
        {emojis
          .filter((emoji) => emoji.name.includes(query.toLowerCase()))
          .map((emoji) => (
            <div className={styles.item} key={emoji.name}>
              <button
                type="button"
                className={styles.emoji}
                aria-label={`Insert :${emoji.name}:`}
                title={`:${emoji.name}:`}
                onClick={() => {
                  onSelect(emoji.name);
                }}
              >
                <img src={emoji.dataUrl} alt="" />
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
            if (file) void onAdd(file);
          }}
        />
      </div>
      <div className={styles.footer}>
        <span className={styles.hint}>Up to 256 KB and 1024 × 1024 pixels</span>
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
