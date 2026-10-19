import { useEffect, useState } from 'react';
import { useSnowdrop } from '@/ui/hooks';
import { Segmented, Switch } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { useSettingsSection } from '../useSettingsSection';

/** Settings → Behaviour's "Keep running in the tray" only makes sense when
 * there's a tray to keep it in (desktop only, and only once `desktop.info()`
 * has answered — see `AboutPage.tsx`'s matching `useDesktopInfo`). */
function useTrayAvailable(): boolean {
  const { desktop } = useSnowdrop();
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void desktop?.info().then((info) => {
      if (live) setAvailable(info.trayAvailable);
    });
    return () => {
      live = false;
    };
  }, [desktop]);
  return available;
}

export function BehaviourPage() {
  const app = useSnowdrop();
  const [b, set] = useSettingsSection('behaviour');
  const trayAvailable = useTrayAvailable();
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
      {app.linkPreviewFetch && (
        <SettingRow
          id="behaviour.linkPreviews"
          label="Link previews"
          description="When a message you're writing has a link, Snowdrop fetches that page's title, description and image directly from this device and attaches them, the same way Signal's own apps do — this device contacts the site, not Signal and not the recipient. Signal's apps additionally hide your IP from the site by routing that fetch through Signal's own relay; Snowdrop has no access to it, so the site does see this device's IP, the same as opening the link in a browser would. You'll see what was found before it sends, and can remove it. Off, nothing is ever fetched — you can still see previews other people send you, since those never involve your device contacting anything."
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={b.linkPreviews}
              onCheckedChange={(v) => {
                set({ linkPreviews: v });
              }}
            />
          )}
        />
      )}
      {trayAvailable && (
        <SettingRow
          id="behaviour.closeToTray"
          label="Keep running in the tray when the window is closed"
          description="Closing the window hides Snowdrop behind its tray icon instead of quitting — messages keep syncing and notifications keep working. Use Quit Snowdrop from the tray icon's menu to actually exit."
          control={(ids) => (
            <Switch
              id={ids.id}
              aria-describedby={ids.descriptionId}
              checked={b.closeToTray}
              onCheckedChange={(v) => {
                set({ closeToTray: v });
              }}
            />
          )}
        />
      )}
    </SettingsSection>
  );
}
