/**
 * The services plugins reach through `PluginContext`: a narrow backend facade
 * (sends go through the normal pipeline), message actions implemented with
 * the same services as the built-in UI, toasts and error reporting.
 */
import type { ChatBackend } from '@/core/backend';
import { bodyToPlainText, type Message } from '@/core/domain';
import type { PluginHost, PluginMessageActions } from '@/core/plugins';
import type { SendService, SyncService } from '@/core/services';
import {
  HOME,
  spacesSelectors,
  uiSelectors,
  UNKNOWN_CONTACT_NAME,
  type Stores,
} from '@/core/stores';
import { focusConversation } from '@/ui/hooks';

export interface PluginHostDeps {
  stores: Stores;
  backend: ChatBackend;
  send: SendService;
  sync: SyncService;
  onError: (error: unknown, pluginId: string, where: string) => void;
  /** Clipboard writes (tests inject a fake); defaults to the browser's. */
  writeClipboard?: (text: string) => Promise<void>;
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const { stores, backend, send, sync } = deps;
  return {
    stores,
    backend: {
      kind: backend.kind,
      status: () => backend.getStatus(),
      sendText: async (conversationId, text) => {
        await send.send({ conversationId, text, mentionIds: [], attachments: [] });
      },
      onMessage: (fn) =>
        sync.on('messageArrived', ({ message, live }) => {
          fn(message, { live });
        }),
    },
    messages: createMessageActions(deps),
    toast: (message, kind, source) => {
      stores.ui.getState().pushToast({ message, kind, source });
    },
    onError: deps.onError,
  };
}

function createMessageActions(deps: PluginHostDeps): PluginMessageActions {
  const { stores, send } = deps;
  const writeClipboard =
    deps.writeClipboard ?? ((text: string) => navigator.clipboard.writeText(text));
  const toast = (message: string, kind: 'success' | 'error') => {
    stores.ui.getState().pushToast({ message, kind, source: 'core' });
  };
  return {
    reply(message: Message) {
      const ui = stores.ui.getState();
      const id = message.conversationId;
      if (uiSelectors.selectedConversation(ui) !== id) {
        const space = spacesSelectors.spaceOf(id)(stores.spaces.getState());
        ui.selectConversation(id, space ?? HOME);
      }
      stores.ui.getState().setReplyTo(id, message.id);
      // Replying is an explicit "type here" intent: always the composer.
      if (typeof requestAnimationFrame !== 'undefined') focusConversation(id, true);
    },
    async react(message: Message, emoji: string) {
      const selfId = stores.session.getState().self?.id;
      if (message.reactions.some((r) => r.authorId === selfId && r.emoji === emoji)) return;
      stores.local.getState().noteReactionUsed(emoji);
      await send.react(message.conversationId, message, emoji);
    },
    async copy(message: Message) {
      const contacts = stores.contacts.getState().byId;
      const text = bodyToPlainText(
        message.body,
        message.ranges,
        (id) => contacts[id]?.name ?? UNKNOWN_CONTACT_NAME,
      );
      try {
        await writeClipboard(text);
        toast('Copied message text', 'success');
      } catch (error) {
        toast("Couldn't copy message text: clipboard access was denied", 'error');
        throw error;
      }
    },
  };
}
