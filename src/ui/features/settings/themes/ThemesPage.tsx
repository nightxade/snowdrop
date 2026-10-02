import { FileUp, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CustomThemeData } from '@/core/stores';
import { exportTheme, parseThemeJson, type Theme } from '@/core/themes';
import { useShrike } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import { downloadText } from '../download';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { ThemeCards } from './ThemeCards';
import styles from './themes.module.css';

const MAX_FILE = 200_000;
/** A theme with its own CSS could hide everything: it applies on probation. */
const TRIAL_SECONDS = 10;

interface Trial {
  themeId: string;
  /** What to go back to. */
  previousThemeId: string;
  /** The theme it replaced (same id), restored on revert; null if it was new. */
  replaced: CustomThemeData | null;
  secondsLeft: number;
}

type Status = { tone: 'danger' | 'warning' | 'success'; lines: string[] } | null;

export function ThemesPage() {
  const { stores, safeMode } = useShrike();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>(null);
  const [confirmReplace, setConfirmReplace] = useState<{
    theme: CustomThemeData;
    warnings: string[];
  } | null>(null);
  const [trial, setTrial] = useState<Trial | null>(null);

  const revert = (t: Trial) => {
    const s = stores.settings.getState();
    s.update('appearance', { themeId: t.previousThemeId });
    if (t.replaced) s.saveCustomTheme(t.replaced);
    else s.removeCustomTheme(t.themeId);
    setTrial(null);
    setStatus({ tone: 'warning', lines: ['Reverted. The imported theme was not kept.'] });
  };

  // Count down; reverting needs no click, so even a theme that hides the bar can't stick.
  useEffect(() => {
    if (!trial) return;
    const timer = setTimeout(() => {
      if (trial.secondsLeft <= 1) revert(trial);
      else setTrial({ ...trial, secondsLeft: trial.secondsLeft - 1 });
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
    // revert reads only stable store actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trial]);

  const apply = (theme: CustomThemeData, warnings: string[]) => {
    const s = stores.settings.getState();
    const replaced = s.customThemes.find((t) => t.id === theme.id) ?? null;
    const previousThemeId = s.appearance.themeId;
    s.saveCustomTheme(theme);
    s.update('appearance', { themeId: theme.id });
    if (theme.css.trim())
      setTrial({ themeId: theme.id, previousThemeId, replaced, secondsLeft: TRIAL_SECONDS });
    setStatus({
      tone: warnings.length > 0 ? 'warning' : 'success',
      lines: [
        `${replaced ? 'Replaced' : 'Imported'} “${theme.name}” and switched to it.`,
        ...warnings,
      ],
    });
  };

  const onExport = (theme: Theme) => {
    // Built-in ids are reserved, so an exported built-in imports as a copy.
    const builtin = !stores.settings.getState().customThemes.some((t) => t.id === theme.id);
    const data = builtin ? { ...theme, id: `${theme.id}-copy`, name: `${theme.name} copy` } : theme;
    downloadText(`${data.id}.shrike-theme.json`, exportTheme(data));
  };

  const onFile = async (file: File) => {
    if (file.size > MAX_FILE) {
      setStatus({ tone: 'danger', lines: ['That file is too large to be a theme (200 kB max).'] });
      return;
    }
    const result = parseThemeJson(await file.text());
    if (!result.ok) {
      setStatus({ tone: 'danger', lines: result.errors.slice(0, 6) });
      return;
    }
    // Same id as a theme you already have: ask before overwriting it.
    if (stores.settings.getState().customThemes.some((t) => t.id === result.theme.id)) {
      setConfirmReplace({ theme: result.theme, warnings: result.warnings });
      return;
    }
    apply(result.theme, result.warnings);
  };

  return (
    <>
      <SettingsSection>
        <SettingRow
          id="themes.builtin"
          label="Themes"
          description="Pick one to apply it. Hover a theme to export it as a starting point for your own."
          stacked
          control={<ThemeCards label="Themes" manage onExport={onExport} />}
        />
        <SettingRow
          id="themes.import"
          label="Import a theme"
          description={
            <>
              A JSON file with <code>name</code>, <code>tokens</code> (design token names such as{' '}
              <code>accent</code> or <code>bg-chat</code>, with CSS values) and optional{' '}
              <code>css</code>. Tokens you leave out keep Dusk’s values. A theme with CSS applies
              for {TRIAL_SECONDS} seconds first, so you can back out. If one ever makes Shrike
              unusable, reload with Shift held (or add <code>?safe=1</code>) to start without it.
            </>
          }
          control={
            <>
              <input
                ref={input}
                type="file"
                accept="application/json,.json"
                className={styles.file}
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void onFile(file);
                }}
              />
              <Button icon={<FileUp size={16} />} onClick={() => input.current?.click()}>
                Choose file
              </Button>
            </>
          }
          noteTone={status?.tone ?? 'info'}
          note={
            status && (
              <span className={styles.status}>
                {status.tone !== 'success' && <TriangleAlert size={14} aria-hidden />}
                <span>
                  {status.lines.map((line) => (
                    <span key={line} className={styles.statusLine}>
                      {line}
                    </span>
                  ))}
                </span>
              </span>
            )
          }
        />
      </SettingsSection>
      {safeMode && (
        <p className={styles.safe} role="status">
          <ShieldAlert size={16} aria-hidden />
          Safe mode is on: imported themes and Custom CSS aren’t applied until you reload Shrike.
        </p>
      )}
      {trial && (
        <div className={styles.trial} role="alertdialog" aria-label="Keep this theme?">
          <span>Keep this theme? Reverting in {trial.secondsLeft}s</span>
          <Button
            size="sm"
            variant="primary"
            data-autofocus
            onClick={() => {
              setTrial(null);
            }}
          >
            Keep
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              revert(trial);
            }}
          >
            Revert
          </Button>
        </div>
      )}
      {confirmReplace && (
        <Modal
          open
          size="sm"
          onOpenChange={(open) => {
            if (!open) setConfirmReplace(null);
          }}
          title={`Replace “${confirmReplace.theme.name}”?`}
          description="You already have a theme with this id. Importing replaces it."
          footer={
            <>
              <Button
                variant="ghost"
                data-autofocus
                onClick={() => {
                  setConfirmReplace(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  apply(confirmReplace.theme, confirmReplace.warnings);
                  setConfirmReplace(null);
                }}
              >
                Replace theme
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
