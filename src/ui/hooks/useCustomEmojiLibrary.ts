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
  CUSTOM_EMOJI_TEXT_MAX_LENGTH,
  parseEmoticonText,
  type CustomEmoji,
} from '@/core/stores/customEmoji';
import { useSnowdrop } from './SnowdropContext';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Why an image can't be an emoji; `message` is the user-facing sentence for a file they picked. */
export type CustomEmojiImageProblem = 'too-large' | 'type' | 'dimensions' | 'unreadable';

export class CustomEmojiImageError extends Error {
  override name = 'CustomEmojiImageError';
  constructor(
    readonly problem: CustomEmojiImageProblem,
    message: string,
  ) {
    super(message);
  }
}

export interface CustomEmojiLibrary {
  emojis: readonly CustomEmoji[];
  busy: boolean;
  /**
   * Validates `file` against the name and size/type rules, reads it, and
   * stores it under `name`. Throws a user-facing `Error` on any failure;
   * callers show `error.message` as-is.
   */
  addImage: (name: string, file: File) => Promise<void>;
  /**
   * The size, type and dimension checks of `addImage`, on their own: reads
   * `file` into the `data:` URL it would be stored as. Rejects with a
   * `CustomEmojiImageError` (whose `message` is worded for a file the user
   * chose; callers with another source word it themselves from `problem`).
   */
  readImage: (file: File) => Promise<string>;
  /**
   * What is wrong with `name` as a new emoji name (invalid, or already in the
   * collection), or `null` if it can be used. Never overwrites: `saveImage`
   * refuses a taken name with this same sentence.
   */
  nameProblem: (name: string) => string | null;
  /** Stores an already-read image (see `readImage`) under a free `name`. Throws a user-facing `Error`. */
  saveImage: (name: string, dataUrl: string) => void;
  /**
   * Validates `text` (non-empty once trimmed, no line breaks, at most
   * `CUSTOM_EMOJI_TEXT_MAX_LENGTH` characters) and stores it under `name`.
   * Throws a user-facing `Error` on any failure; callers show
   * `error.message` as-is.
   */
  addText: (name: string, text: string) => void;
  remove: (name: string) => void;
}

export function useCustomEmojiLibrary(): CustomEmojiLibrary {
  const { stores } = useSnowdrop();
  const emojis = useStore(stores.local, (s) => s.customEmoji);
  const [busy, setBusy] = useState(false);

  const nameProblem = (name: string): string | null => {
    if (!CUSTOM_EMOJI_NAME.test(name))
      return 'Name your emoji using 1–32 lowercase letters, numbers, +, - or _.';
    if (emojis.some((emoji) => emoji.name === name))
      return 'That name is already in your collection. Choose another.';
    return null;
  };

  const checkName = (name: string): void => {
    const problem = nameProblem(name);
    if (problem) throw new Error(problem);
  };

  const saveImage = (name: string, dataUrl: string): void => {
    checkName(name);
    stores.local.getState().saveCustomEmoji({ kind: 'image', name, dataUrl });
  };

  const addImage = async (name: string, file: File): Promise<void> => {
    setBusy(true);
    const account = stores.session.getState().self?.id;
    try {
      checkName(name);
      const dataUrl = await readCustomEmojiImage(file);
      // A slow read must not land in an account the user has since switched away from.
      if (stores.session.getState().self?.id !== account) return;
      saveImage(name, dataUrl);
    } finally {
      setBusy(false);
    }
  };

  const addText = (name: string, text: string): void => {
    checkName(name);
    const parsed = parseEmoticonText(text);
    if (parsed === null)
      throw new Error(`Use 1–${CUSTOM_EMOJI_TEXT_MAX_LENGTH} characters, no line breaks.`);
    stores.local.getState().saveCustomEmoji({ kind: 'text', name, text: parsed });
  };

  return {
    emojis,
    busy,
    addImage,
    readImage: readCustomEmojiImage,
    nameProblem,
    saveImage,
    addText,
    remove: (name) => {
      stores.local.getState().removeCustomEmoji(name);
    },
  };
}

/** Validates `file` as a custom emoji image and reads it as a `data:` URL. */
export function readCustomEmojiImage(file: File): Promise<string> {
  if (file.size > CUSTOM_EMOJI_MAX_BYTES)
    return Promise.reject(
      new CustomEmojiImageError('too-large', 'Choose an image smaller than 256 KB.'),
    );
  if (!ACCEPTED_TYPES.includes(file.type))
    return Promise.reject(
      new CustomEmojiImageError('type', 'Choose a PNG, JPEG, GIF or WebP image.'),
    );
  return new Promise((resolve, reject) => {
    const unreadable = (message: string) => {
      reject(new CustomEmojiImageError('unreadable', message));
    };
    const reader = new FileReader();
    reader.onerror = () => {
      unreadable('Could not read this image.');
    };
    reader.onload = () => {
      const url = reader.result;
      if (typeof url !== 'string') {
        unreadable('Could not read this image.');
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth > 1024 || image.naturalHeight > 1024) {
          reject(
            new CustomEmojiImageError(
              'dimensions',
              'Choose an image no larger than 1024 × 1024 pixels.',
            ),
          );
        } else resolve(url);
      };
      image.onerror = () => {
        unreadable('This file could not be opened as an image.');
      };
      image.src = url;
    };
    reader.readAsDataURL(file);
  });
}
