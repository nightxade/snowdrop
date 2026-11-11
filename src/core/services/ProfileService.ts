/**
 * The user's own profile (name, about, photo), edited from Settings.
 */
import type { ChatBackend, ProfileUpdate } from '@/core/backend';
import type { Contact } from '@/core/domain';
import type { Stores } from '@/core/stores';
import { consoleReporter, type ErrorReporter } from './types';

export interface ProfileServiceDeps {
  backend: ChatBackend;
  stores: Stores;
  onError?: ErrorReporter;
}

export class ProfileService {
  private readonly onError: ErrorReporter;

  constructor(private readonly deps: ProfileServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /**
   * Settings → Profile: saves the user's own name, about and photo, then
   * shows them at once. Returns null on success or a short message to show
   * inline; nothing changes on failure. The photo isn't something signal-cli
   * lists back, so what was just set is kept for this session (a restart
   * shows whatever signal-cli reports).
   */
  async update(update: ProfileUpdate): Promise<string | null> {
    const { backend, stores } = this.deps;
    if (!backend.capabilities.features.has('profile'))
      return "This connection can't change your profile.";
    const before = stores.session.getState().self;
    try {
      const fresh = await backend.updateProfile(update);
      const self: Contact = { ...fresh, isSelf: true };
      if (update.avatar) {
        self.avatarUrl = `data:${update.avatar.contentType};base64,${update.avatar.base64}`;
      } else if (update.avatar === undefined && before?.avatarUrl) {
        self.avatarUrl = before.avatarUrl;
      } else delete self.avatarUrl;
      stores.session.getState().setSelf(self);
      stores.contacts.getState().upsert(self);
      return null;
    } catch (error) {
      this.onError(error, 'profile update failed');
      return "Couldn't save your profile. Check your connection and try again.";
    }
  }
}
