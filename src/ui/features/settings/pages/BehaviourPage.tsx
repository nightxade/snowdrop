import { Segmented, Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';

export function BehaviourPage() {
  const [b, set] = useSettingsSection('behaviour');
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
        control={(ids) => (
          <Segmented
            labelledBy={ids.labelId}
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
        )}
      />
      <SettingRow
        id="behaviour.focusComposerOnOpen"
        label="Focus the message box when opening a conversation"
        description="When you open a conversation from the switcher, a notification or a keyboard shortcut, put the cursor in the message box instead of on the newest message. Clicking or pressing Enter on a conversation in the sidebar always keeps focus there. Ignored in Vim mode, which always lands on the message list — use i/a/I/A/gi for the composer."
        control={(ids) => (
          <Switch
            id={ids.id}
            aria-describedby={ids.descriptionId}
            checked={b.focusComposerOnOpen}
            onCheckedChange={(v) => {
              set({ focusComposerOnOpen: v });
            }}
          />
        )}
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
    </SettingsSection>
  );
}
