import {
  Copy,
  Hash,
  Pencil,
  Pin,
  PinOff,
  Reply,
  RotateCw,
  SmilePlus,
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

  const plugins = app.registries.menus.message.list().filter((item) => {
    try {
      return item.visible?.(m) ?? true;
    } catch {
      return false;
    }
  });
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
          try {
            item.onSelect(m);
          } catch (error) {
            console.error(`[shrike] plugin "${item.owner}" menu item failed`, error);
          }
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
