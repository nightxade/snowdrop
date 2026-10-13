/**
 * Shared by the composer's "My emoji" tab (CustomEmojiPanel) and Settings →
 * Custom emoji: the same add/validate/remove logic, backed by the same
 * per-account store (core/stores/customEmoji.ts, local.ts).
 */
import { useState } from 'react';
import { useStore } from 'zustand';
import {
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_NAME,
  type CustomEmoji,
} from '@/core/stores/customEmoji';
import { useSnowdrop } from './SnowdropContext';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export interface CustomEmojiLibrary {
  emojis: readonly CustomEmoji[];
  busy: boolean;
  /**
   * Validates `file` against the name and size/type rules, reads it, and
   * stores it under `name`. Throws a user-facing `Error` on any failure;
   * callers show `error.message` as-is.
   */
  add: (name: string, file: File) => Promise<void>;
  remove: (name: string) => void;
}

export function useCustomEmojiLibrary(): CustomEmojiLibrary {
  const { stores } = useSnowdrop();
  const emojis = useStore(stores.local, (s) => s.customEmoji);
  const [busy, setBusy] = useState(false);

  const add = async (name: string, file: File): Promise<void> => {
    setBusy(true);
    const account = stores.session.getState().self?.id;
    try {
      if (!CUSTOM_EMOJI_NAME.test(name))
        throw new Error('Name your emoji using 1–32 lowercase letters, numbers, +, - or _.');
      if (emojis.some((emoji) => emoji.name === name))
        throw new Error('That name is already in your collection. Choose another.');
      if (file.size > CUSTOM_EMOJI_MAX_BYTES)
        throw new Error('Choose an image smaller than 256 KB.');
      if (!ACCEPTED_TYPES.includes(file.type))
        throw new Error('Choose a PNG, JPEG, GIF or WebP image.');
      const dataUrl = await readImage(file);
      // A slow read must not land in an account the user has since switched away from.
      if (stores.session.getState().self?.id !== account) return;
      stores.local.getState().saveCustomEmoji({ name, dataUrl });
    } finally {
      setBusy(false);
    }
  };

  return {
    emojis,
    busy,
    add,
    remove: (name) => {
      stores.local.getState().removeCustomEmoji(name);
    },
  };
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
