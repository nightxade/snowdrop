import { createContactsStore, type ContactsStore } from './contacts';
import { createIdentitiesStore, type IdentitiesStore } from './identities';
import { createLocalStore, type LocalData, type LocalStore } from './local';
import { createConversationsStore, type ConversationsStore } from './conversations';
import { createMessagesStore, type MessagesStore } from './messages';
import { createSessionStore, type SessionStore } from './session';
import { createSettingsStore, type Settings, type SettingsStore } from './settings';
import { createSpacesStore, type SpacesData, type SpacesStore } from './spaces';
import { createTypingStore, type TypingStore } from './typing';
import { createUiStore, type UiStore } from './ui';

export * from './contacts';
export * from './identities';
export * from './local';
export * from './messageRequests';
export * from './privacy';
export * from './views';
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
  /** Device-local conversation state (pin/mute/archive/draft) and contact notes. */
  local: LocalStore;
  messages: MessagesStore;
  /** Trust level of people's keys, as last read (the verified badge). */
  identities: IdentitiesStore;
  typing: TypingStore;
  spaces: SpacesStore;
  ui: UiStore;
  settings: SettingsStore;
}

export interface StoresInit {
  settings?: Settings;
  spaces?: SpacesData;
  local?: LocalData;
  /** Max messages per conversation window. */
  windowCap?: number;
}

export function createStores(init: StoresInit = {}): Stores {
  return {
    session: createSessionStore(),
    contacts: createContactsStore(),
    conversations: createConversationsStore(),
    local: createLocalStore(init.local),
    messages: createMessagesStore(init.windowCap),
    identities: createIdentitiesStore(),
    typing: createTypingStore(),
    spaces: createSpacesStore(init.spaces),
    ui: createUiStore(),
    settings: createSettingsStore(init.settings),
  };
}
