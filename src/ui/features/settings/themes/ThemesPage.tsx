import { FileUp, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { exportTheme, parseThemeJson, type Theme } from '@/core/themes';
import { useStores } from '@/ui/hooks';
import { Button } from '@/ui/primitives';
import { downloadText } from '../download';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { ThemeCards } from './ThemeCards';
import styles from './themes.module.css';

const MAX_FILE = 200_000;

type Status = { tone: 'danger' | 'warning' | 'success'; lines: string[] } | null;

export function ThemesPage() {
  const stores = useStores();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>(null);

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
    const s = stores.settings.getState();
    const replaced = s.customThemes.some((t) => t.id === result.theme.id);
    s.saveCustomTheme(result.theme);
    s.update('appearance', { themeId: result.theme.id });
    setStatus({
      tone: result.warnings.length > 0 ? 'warning' : 'success',
      lines: [
        `${replaced ? 'Updated' : 'Imported'} “${result.theme.name}” and switched to it.`,
        ...result.warnings,
      ],
    });
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
              <code>css</code>. Tokens you leave out keep Dusk’s values.
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
    </>
  );
}
