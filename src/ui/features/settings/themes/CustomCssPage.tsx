import { ChevronRight, RotateCcw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { removedSummary, sanitizeUserCss, TOKEN_NAMES } from '@/core/themes';
import { useShrike } from '@/ui/hooks';
import { Button } from '@/ui/primitives';
import { CodeEditor } from '@/ui/primitives/CodeEditor';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import styles from './customcss.module.css';

const APPLY_DELAY_MS = 300;

/** Stable styling hooks (data-shrike="…") documented for user CSS. */
export const STYLE_HOOKS: { hook: string; what: string }[] = [
  { hook: 'app', what: 'The whole shell' },
  { hook: 'rail', what: 'Spaces rail' },
  { hook: 'sidebar', what: 'Conversation sidebar' },
  { hook: 'sidebar-header', what: 'Sidebar title bar' },
  { hook: 'conversation-list', what: 'Conversation list' },
  { hook: 'conversation-row', what: 'One conversation in the sidebar' },
  { hook: 'section-header', what: 'Sidebar section / category header' },
  { hook: 'user-panel', what: 'Your profile at the bottom of the sidebar' },
  { hook: 'chat', what: 'Chat column' },
  { hook: 'chat-header', what: 'Chat title bar' },
  { hook: 'message-pane', what: 'Message area' },
  { hook: 'message-log', what: 'The message list' },
  { hook: 'message', what: 'One message (has data-compact, data-mention, data-continuation)' },
  { hook: 'message-body', what: 'The text of a message' },
  { hook: 'hover-bar', what: 'Message hover actions' },
  { hook: 'system-message', what: 'Joined / renamed / timer lines' },
  { hook: 'new-divider', what: 'The “new messages” line' },
  { hook: 'composer', what: 'Message composer' },
  { hook: 'typing-line', what: '“… is typing” strip' },
  { hook: 'members', what: 'Member list' },
  { hook: 'member-row', what: 'One member' },
  { hook: 'settings', what: 'Settings screen' },
  { hook: 'plugin-card', what: 'A plugin in Settings → Plugins' },
];

const PLACEHOLDER = `/* Example: roomier messages and a softer mention tint */
[data-shrike='message'] {
  padding-block: 4px;
}

:root {
  --shrike-mention-bg: rgba(212, 116, 74, 0.06);
}`;

export function CustomCssPage() {
  const { stores, safeMode } = useShrike();
  const saved = useStore(stores.settings, (s) => s.customCss);
  const [draft, setDraft] = useState(saved);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  }, [draft]);

  // Apply on unmount too, so closing settings mid-pause doesn't lose the last keystrokes.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        stores.settings.getState().setCustomCss(latest.current);
      }
    },
    [stores],
  );

  const change = (css: string) => {
    setDraft(css);
    setPending(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      stores.settings.getState().setCustomCss(css);
      setPending(false);
    }, APPLY_DELAY_MS);
  };

  const summary = removedSummary(sanitizeUserCss(draft).removed);
  const lines = draft ? draft.split('\n').length : 0;

  return (
    <>
      {safeMode && (
        <p className={styles.safe} role="status">
          <ShieldAlert size={16} aria-hidden />
          Safe mode is on: this CSS isn’t applied until you reload Shrike normally.
        </p>
      )}
      <SettingsSection>
        <SettingRow
          id="custom-css.editor"
          label="Editor"
          description="Applied live, a moment after you stop typing. Tab indents; press Esc to Tab out. If something makes Shrike unusable, reload with Shift held (or add ?safe=1 to the address) to start without your CSS and themes."
          stacked
          control={
            <div className={styles.editorWrap}>
              <CodeEditor
                className={styles.editor}
                label="Custom CSS"
                value={draft}
                placeholder={PLACEHOLDER}
                onValueChange={change}
              />
              <div className={styles.bar}>
                <span className={styles.state} aria-live="polite">
                  {pending
                    ? 'Applying…'
                    : draft
                      ? `Applied · ${lines} line${lines === 1 ? '' : 's'}`
                      : 'Empty'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw size={14} />}
                  disabled={!draft}
                  onClick={() => {
                    if (timer.current) clearTimeout(timer.current);
                    timer.current = null;
                    setPending(false);
                    setDraft('');
                    stores.settings.getState().setCustomCss('');
                    stores.ui.getState().pushToast({
                      message: 'Custom CSS cleared',
                      kind: 'info',
                      source: 'core',
                    });
                  }}
                >
                  Reset
                </Button>
              </div>
            </div>
          }
          noteTone="warning"
          note={
            summary ? (
              <>
                <TriangleAlert size={14} aria-hidden />
                {summary} (@import, url(), image-set()). Custom CSS can’t load anything from the
                internet: that would tell other servers when you use Shrike. Paste styles in
                directly; images can be data: URLs.
              </>
            ) : undefined
          }
        />
        <SettingRow id="custom-css.hooks" label="Styling hooks" stacked>
          <details className={styles.help}>
            <summary className={styles.summary}>
              <ChevronRight size={16} aria-hidden className={styles.chevron} />
              Stable selectors and tokens
            </summary>
            <div className={styles.helpBody}>
              <p>
                Class names change between versions; these don’t. Target regions with{' '}
                <code>[data-shrike='name']</code>:
              </p>
              <dl className={styles.hooks}>
                {STYLE_HOOKS.map((h) => (
                  <div key={h.hook} className={styles.hookRow}>
                    <dt>
                      <code>{h.hook}</code>
                    </dt>
                    <dd>{h.what}</dd>
                  </div>
                ))}
              </dl>
              <p>
                Colours, spacing and type are custom properties named <code>--shrike-*</code>, e.g.{' '}
                {TOKEN_NAMES.slice(0, 6).map((t, i) => (
                  <span key={t}>
                    {i > 0 && ', '}
                    <code>--shrike-{t}</code>
                  </span>
                ))}{' '}
                ({TOKEN_NAMES.length} in all). The root element also carries <code>data-theme</code>
                , <code>data-theme-kind</code> and <code>data-density</code>.
              </p>
            </div>
          </details>
        </SettingRow>
      </SettingsSection>
    </>
  );
}
