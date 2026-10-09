import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_NAME,
  customEmojiFile,
  type CustomEmoji,
} from '@/core/stores/customEmoji';
import { useSnowdrop } from '@/ui/hooks';
import { Button, IconButton } from '@/ui/primitives';
import { Trash2 } from 'lucide-react';
import styles from './CustomEmojiPanel.module.css';

export function CustomEmojiPanel({ onSelect }: { onSelect: (file: File) => void }) {
  const { stores } = useSnowdrop();
  const emojis = useStore(stores.local, (s) => s.customEmoji);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const add = async (file: File) => {
    setError(null);
    setBusy(true);
    const account = stores.session.getState().self?.id;
    try {
      if (!CUSTOM_EMOJI_NAME.test(name))
        throw new Error('Name your emoji using 1–32 lowercase letters, numbers, +, - or _.');
      if (emojis.some((emoji) => emoji.name === name))
        throw new Error('That name is already in your collection. Choose another.');
      if (file.size > CUSTOM_EMOJI_MAX_BYTES)
        throw new Error('Choose an image smaller than 256 KB.');
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
        throw new Error('Choose a PNG, JPEG, GIF or WebP image.');
      }
      const dataUrl = await readImage(file);
      if (stores.session.getState().self?.id !== account) return;
      stores.local.getState().saveCustomEmoji({ name, dataUrl });
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add this emoji.');
    } finally {
      setBusy(false);
    }
  };
  const select = (emoji: CustomEmoji) => {
    try {
      onSelect(customEmojiFile(emoji));
    } catch {
      setError('This emoji could not be opened. Remove it and add it again.');
    }
  };

  return (
    <section className={styles.panel} aria-label="My emoji">
      <p className={styles.hint}>Your collection on this device. Sends as an image.</p>
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
                aria-label={`Attach :${emoji.name}:`}
                title={`:${emoji.name}:`}
                onClick={() => {
                  select(emoji);
                }}
              >
                <img src={emoji.dataUrl} alt="" />
              </button>
              {manage && (
                <IconButton
                  label={`Remove :${emoji.name}:`}
                  icon={<Trash2 />}
                  onClick={() => {
                    stores.local.getState().removeCustomEmoji(emoji.name);
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
            if (file) void add(file);
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

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Could not read this image.'));
    };
    reader.onload = () => {
      const url = reader.result;
      if (typeof url !== 'string') {
        reject(new Error('Could not read this image.'));
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth > 1024 || image.naturalHeight > 1024) {
          reject(new Error('Choose an image no larger than 1024 × 1024 pixels.'));
        } else resolve(url);
      };
      image.onerror = () => {
        reject(new Error('This file could not be opened as an image.'));
      };
      image.src = url;
    };
    reader.readAsDataURL(file);
  });
}
