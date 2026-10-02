import { useShrike } from '@/ui/hooks';
import { Segmented, Switch } from '@/ui/primitives';
import { useSyncExternalStore } from 'react';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';

export function BehaviourPage() {
  const { plugins } = useShrike();
  const [b, set] = useSettingsSection('behaviour');
  const silent = useSyncExternalStore(
    (fn) => plugins.subscribe(fn),
    () => plugins.get('silent-typing')?.enabled ?? false,
  );
  return (
    <SettingsSection>
      <SettingRow
        id="behaviour.enter"
        label="Send with"
        description={
          b.enterToSend
            ? 'Enter sends; Shift+Enter starts a new line.'
            : 'Shift+Enter sends; Enter starts a new line.'
        }
        control={
          <Segmented
            label="Send with"
            value={b.enterToSend ? 'enter' : 'shift'}
            options={[
              { value: 'enter', label: 'Enter' },
              { value: 'shift', label: 'Shift+Enter' },
            ]}
            onValueChange={(v) => {
              set({ enterToSend: v === 'enter' });
            }}
          />
        }
      />
      <SettingRow
        id="behaviour.markdown"
        label="Markdown formatting"
        description="Turns **bold**, *italic*, ~~strike~~, `code` and ||spoilers|| into real Signal formatting when you send."
        control={(ids) => (
          <Switch
            id={ids.id}
            aria-describedby={ids.descriptionId}
            checked={b.markdown}
            onCheckedChange={(v) => {
              set({ markdown: v });
            }}
          />
        )}
      />
      <SettingRow
        id="behaviour.typing"
        label="Send typing indicators"
        description={
          silent
            ? 'The Silent Typing plugin is on, so nothing is sent whatever this says.'
            : 'Show others when you’re typing a message to them.'
        }
        control={(ids) => (
          <Switch
            id={ids.id}
            aria-describedby={ids.descriptionId}
            checked={b.sendTypingIndicators && !silent}
            disabled={silent}
            onCheckedChange={(v) => {
              set({ sendTypingIndicators: v });
            }}
          />
        )}
      />
      <SettingRow
        id="behaviour.previews"
        label="Link previews"
        description="Off: Shrike never contacts the websites people link to, so they can’t see that you received the link. Previews aren’t available in this version."
        disabled
        control={(ids) => (
          <Switch
            id={ids.id}
            aria-describedby={ids.descriptionId}
            checked={false}
            disabled
            onCheckedChange={() => undefined}
          />
        )}
      />
    </SettingsSection>
  );
}
