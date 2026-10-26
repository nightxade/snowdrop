import {
  Copy,
  Forward,
  CircleStop,
  Hash,
  Info,
  Pencil,
  Pin,
  PinOff,
  Reply,
  RotateCw,
  Smile,
  SmilePlus,
  Sticker,
  Trash2,
  FileCode,
} from 'lucide-react';
import type { Message } from '@/core/domain';
import { localSelectors } from '@/core/stores';
import type { AppServices } from '@/ui/hooks';
import { isRenderableComponent, type MenuEntry } from '@/ui/primitives';
import type { ChatController } from '../ChatController';
import * as act from './actions';

export type DeleteKind = 'everyone' | 'me' | 'admin';

export interface MenuCallbacks {
  openPicker: () => void;
  /** Asks before deleting (skipped when Shift is held). */
  requestDelete: (kind: DeleteKind) => void;
  /** Opens the "Message details" dialog (own messages only — see MessageDetails). */
  openDetails: () => void;
  /** Asks to end this poll (confirmed first; only offered on the user's own open polls). */
  requestEndPoll: () => void;
  /** Opens the pack dialog for this message's sticker. */
  openStickerPack: () => void;
  /** Opens the "add to my emoji" dialog for one emoji this message delivered. */
  openCustomEmoji: (name: string) => void;
}

const ICON = 16;

/** Entries of a message's context menu and its "More" dropdown. */
export function buildMessageMenu(
  app: AppServices,
  chat: ChatController,
  m: Message,
  cb: MenuCallbacks,
): MenuEntry[] {
  const p = act.permissionsFor(app, m);
  const entries: MenuEntry[] = [];

  if (p.failed) {
    entries.push(
      {
        kind: 'item',
        id: 'retry',
        label: 'Retry sending',
        icon: <RotateCw size={ICON} />,
        onSelect: () => {
          act.retry(app, m);
        },
      },
      {
        kind: 'item',
        id: 'discard',
        label: 'Delete',
        icon: <Trash2 size={ICON} />,
        danger: true,
        onSelect: () => {
          act.discard(app, m);
        },
      },
      { kind: 'separator', id: 'sep-failed' },
    );
  }

  if (p.canReact) {
    const quick = localSelectors.quickReactions(app.stores.local.getState());
    entries.push({
      kind: 'submenu',
      id: 'react',
      label: 'Add reaction',
      icon: <SmilePlus size={ICON} />,
      items: [
        ...quick.map((emoji): MenuEntry => ({
          kind: 'item',
          id: `react-${emoji}`,
          label: emoji,
          onSelect: () => {
            act.react(app, m, emoji);
          },
        })),
        { kind: 'separator', id: 'react-sep' },
        { kind: 'item', id: 'react-more', label: 'More reactions…', onSelect: cb.openPicker },
      ],
    });
  }
  if (m.kind === 'normal' && !m.deleted && !p.failed) {
    entries.push({
      kind: 'item',
      id: 'reply',
      label: 'Reply',
      icon: <Reply size={ICON} />,
      onSelect: () => {
        act.reply(app, chat, m);
      },
    });
  }
  if (p.canForward) {
    entries.push({
      kind: 'item',
      id: 'forward',
      label: 'Forward',
      icon: <Forward size={ICON} />,
      onSelect: () => {
        act.forward(app, m);
      },
    });
  }
  if (p.canEdit && !p.failed) {
    entries.push({
      kind: 'item',
      id: 'edit',
      label: 'Edit message',
      icon: <Pencil size={ICON} />,
      onSelect: () => {
        act.startEdit(app, m);
      },
    });
  }
  if (p.canPin) {
    entries.push(
      m.pinned
        ? {
            kind: 'item',
            id: 'unpin',
            label: 'Unpin message',
            icon: <PinOff size={ICON} />,
            onSelect: () => {
              act.setPinned(app, m, false);
            },
          }
        : {
            kind: 'item',
            id: 'pin',
            label: 'Pin message',
            icon: <Pin size={ICON} />,
            onSelect: () => {
              act.setPinned(app, m, true);
            },
          },
    );
  }

  if (p.canEndPoll) {
    entries.push({
      kind: 'item',
      id: 'end-poll',
      label: 'End poll',
      icon: <CircleStop size={ICON} />,
      onSelect: cb.requestEndPoll,
    });
  }

  if (p.own && !p.failed && m.kind === 'normal' && !m.deleted) {
    entries.push({
      kind: 'item',
      id: 'details',
      label: 'Message details',
      icon: <Info size={ICON} />,
      onSelect: cb.openDetails,
    });
  }

  if (m.kind === 'normal' && !m.deleted && m.sticker && app.backend.getStickerPack) {
    entries.push({
      kind: 'item',
      id: 'sticker-pack',
      label: 'View sticker pack',
      icon: <Sticker size={ICON} />,
      onSelect: cb.openStickerPack,
    });
  }

  // Emoji someone else delivered with this message (never your own: those
  // are already in your collection).
  const delivered = !p.own && m.kind === 'normal' && !m.deleted ? (m.customEmoji ?? []) : [];
  const first = delivered[0];
  if (delivered.length === 1 && first) {
    entries.push({
      kind: 'item',
      id: `emoji-${first.name}`,
      label: `Add :${first.name}: to my emoji`,
      icon: <Smile size={ICON} />,
      onSelect: () => {
        cb.openCustomEmoji(first.name);
      },
    });
  } else if (delivered.length > 1) {
    entries.push({
      kind: 'submenu',
      id: 'emoji',
      label: 'Add to my emoji',
      icon: <Smile size={ICON} />,
      items: delivered.map((d): MenuEntry => ({
        kind: 'item',
        id: `emoji-${d.name}`,
        label: `:${d.name}:`,
        onSelect: () => {
          cb.openCustomEmoji(d.name);
        },
      })),
    });
  }

  if (m.kind === 'normal' && !m.deleted && m.body !== '') {
    entries.push(
      { kind: 'separator', id: 'sep-copy' },
      {
        kind: 'item',
        id: 'copy',
        label: 'Copy text',
        icon: <Copy size={ICON} />,
        onSelect: () => {
          act.copyMessageText(app, m);
        },
      },
      {
        kind: 'item',
        id: 'copy-md',
        label: 'Copy as Markdown',
        icon: <FileCode size={ICON} />,
        onSelect: () => {
          act.copyMarkdown(app, m);
        },
      },
    );
  }

  const plugins = app.registries.menus.message
    .list()
    .filter((item) => app.registries.isVisible(item, m, 'menu item'));
  if (plugins.length > 0) {
    entries.push({ kind: 'separator', id: 'sep-plugins' });
    for (const item of plugins) {
      const Icon = isRenderableComponent<{ size?: number }>(item.icon) ? item.icon : null;
      entries.push({
        kind: 'item',
        id: `plugin-${item.owner}-${item.id}`,
        label: item.label,
        ...(Icon ? { icon: <Icon size={ICON} /> } : {}),
        ...(item.danger ? { danger: true } : {}),
        onSelect: () => {
          app.registries.invoke(item, 'menu item', () => item.onSelect(m));
        },
      });
    }
  }

  entries.push(
    { kind: 'separator', id: 'sep-id' },
    {
      kind: 'item',
      id: 'copy-id',
      label: 'Copy message ID',
      icon: <Hash size={ICON} />,
      onSelect: () => {
        act.copyMessageId(app, m);
      },
    },
  );

  if (!p.failed) {
    entries.push({ kind: 'separator', id: 'sep-delete' });
    if (p.own && m.kind === 'normal' && !m.deleted) {
      entries.push({
        kind: 'item',
        id: 'delete-everyone',
        label: 'Delete for everyone',
        icon: <Trash2 size={ICON} />,
        danger: true,
        onSelect: () => {
          cb.requestDelete('everyone');
        },
      });
    }
    if (p.canAdminDelete) {
      entries.push({
        kind: 'item',
        id: 'delete-admin',
        label: 'Delete for everyone (admin)',
        icon: <Trash2 size={ICON} />,
        danger: true,
        onSelect: () => {
          cb.requestDelete('admin');
        },
      });
    }
    entries.push({
      kind: 'item',
      id: 'delete-me',
      label: 'Delete for me',
      icon: <Trash2 size={ICON} />,
      danger: true,
      onSelect: () => {
        cb.requestDelete('me');
      },
    });
  }
  return entries;
}
