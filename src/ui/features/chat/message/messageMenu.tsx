import type { ReactElement } from 'react';
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
import { retryCopy, type Message } from '@/core/domain';
import { localSelectors } from '@/core/stores';
import type { AppServices } from '@/ui/hooks';
import { isRenderableComponent, type MenuEntry } from '@/ui/primitives';
import type { ChatController } from '../ChatController';
import * as act from './actions';
import { messageActionEnabled, runMessageAction, type MessageActionId } from './actions';

export interface MenuCallbacks {
  openPicker: () => void;
  /** Asks before deleting (skipped when Shift is held). */
  requestDelete: (kind: act.DeleteKind) => void;
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
  const ctx: act.ActionContext = {
    app,
    chat,
    m,
    p,
    openPicker: cb.openPicker,
    requestDelete: cb.requestDelete,
    openDetails: cb.openDetails,
    requestEndPoll: cb.requestEndPoll,
    open: () => false,
  };
  const offers = (id: MessageActionId) => messageActionEnabled(id, p, m);
  const item = (
    action: MessageActionId,
    id: string,
    label: string,
    icon: ReactElement,
    danger = false,
  ): MenuEntry => ({
    kind: 'item',
    id,
    label,
    icon,
    ...(danger ? { danger: true } : {}),
    onSelect: () => {
      runMessageAction(action, ctx);
    },
  });

  if (offers('retry')) {
    entries.push(
      item('retry', 'retry', retryCopy(m).menuLabel, <RotateCw size={ICON} />),
      item('discard', 'discard', 'Delete', <Trash2 size={ICON} />, true),
      { kind: 'separator', id: 'sep-failed' },
    );
  }

  if (offers('react')) {
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
        {
          kind: 'item',
          id: 'react-more',
          label: 'More reactions…',
          onSelect: () => {
            runMessageAction('react', ctx);
          },
        },
      ],
    });
  }
  if (offers('reply')) entries.push(item('reply', 'reply', 'Reply', <Reply size={ICON} />));
  if (offers('forward'))
    entries.push(item('forward', 'forward', 'Forward', <Forward size={ICON} />));
  if (offers('edit')) entries.push(item('edit', 'edit', 'Edit message', <Pencil size={ICON} />));
  if (offers('pin')) {
    entries.push(
      m.pinned
        ? item('pin', 'unpin', 'Unpin message', <PinOff size={ICON} />)
        : item('pin', 'pin', 'Pin message', <Pin size={ICON} />),
    );
  }
  if (offers('endPoll')) {
    entries.push(item('endPoll', 'end-poll', 'End poll', <CircleStop size={ICON} />));
  }

  if (offers('details')) {
    entries.push(item('details', 'details', 'Message details', <Info size={ICON} />));
  }

  if (
    m.kind === 'normal' &&
    !m.deleted &&
    m.sticker &&
    app.backend.capabilities.features.has('stickers')
  ) {
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

  if (offers('copyText')) {
    entries.push(
      { kind: 'separator', id: 'sep-copy' },
      item('copyText', 'copy', 'Copy text', <Copy size={ICON} />),
      item('copyMarkdown', 'copy-md', 'Copy as Markdown', <FileCode size={ICON} />),
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

  if (offers('deleteMe')) {
    entries.push({ kind: 'separator', id: 'sep-delete' });
    if (offers('deleteEveryone')) {
      entries.push(
        item(
          'deleteEveryone',
          'delete-everyone',
          'Delete for everyone',
          <Trash2 size={ICON} />,
          true,
        ),
      );
    }
    if (offers('deleteAdmin')) {
      entries.push(
        item(
          'deleteAdmin',
          'delete-admin',
          'Delete for everyone (admin)',
          <Trash2 size={ICON} />,
          true,
        ),
      );
    }
    entries.push(item('deleteMe', 'delete-me', 'Delete for me', <Trash2 size={ICON} />, true));
  }
  return entries;
}
