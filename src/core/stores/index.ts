import { createContactsStore, type ContactsStore } from './contacts';
import { createConversationsStore, type ConversationsStore } from './conversations';
import { createMessagesStore, type MessagesStore } from './messages';
import { createSessionStore, type SessionStore } from './session';
import { createSettingsStore, type Settings, type SettingsStore } from './settings';
import { createSpacesStore, type SpacesData, type SpacesStore } from './spaces';
import { createTypingStore, type TypingStore } from './typing';
import { createUiStore, type UiStore } from './ui';

export * from './contacts';
export * from './conversations';
export * from './messages';
export * from './session';
export * from './settings';
export * from './spaces';
export * from './typing';
export * from './ui';

/** Every store the app runs on. Passed around as one bag so wiring stays explicit. */
export interface Stores {
  session: SessionStore;
  contacts: ContactsStore;
  conversations: ConversationsStore;
  messages: MessagesStore;
  typing: TypingStore;
  spaces: SpacesStore;
  ui: UiStore;
  settings: SettingsStore;
}

export interface StoresInit {
  settings?: Settings;
  spaces?: SpacesData;
}

export function createStores(init: StoresInit = {}): Stores {
  return {
    session: createSessionStore(),
    contacts: createContactsStore(),
    conversations: createConversationsStore(),
    messages: createMessagesStore(),
    typing: createTypingStore(),
    spaces: createSpacesStore(init.spaces),
    ui: createUiStore(),
    settings: createSettingsStore(init.settings),
  };
}
