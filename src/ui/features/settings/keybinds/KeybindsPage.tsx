import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useMemo, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { useShrike } from '@/ui/hooks';
import { Button, IconButton, Kbd } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { KeybindRecorder } from './KeybindRecorder';
import { keybindConflicts, keybindProblem } from './record';
import styles from './keybinds.module.css';
import { useState } from 'react';

export function KeybindsPage() {
  const { commands, stores, plugins } = useShrike();
  const all = useSyncExternalStore(
    (fn) => commands.subscribe(fn),
    () => commands.all(),
  );
  const pluginList = useSyncExternalStore(
    (fn) => plugins.subscribe(fn),
    () => plugins.list(),
  );
  const overrides = useStore(stores.settings, (s) => s.keybinds);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const conflicts = useMemo(() => keybindConflicts(all, overrides), [all, overrides]);
  const titleOf = (id: string) => all.find((c) => c.id === id)?.title ?? id;
  const pluginName = (owner: string) =>
    pluginList.find((p) => p.definition.id === owner)?.definition.name ?? owner;

  const groups = new Map<string, typeof all>();
  for (const c of all) {
    if (c.hidden) continue;
    const key = c.category ?? (c.owner === 'core' ? 'Other' : 'Plugins');
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <>
      <div className={styles.intro}>
        <p>
          Click a shortcut, then press the new keys. <Kbd combo="Esc" /> cancels,{' '}
          <Kbd combo="Backspace" /> removes it.
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw size={14} />}
          disabled={!hasOverrides}
          onClick={() => {
            stores.settings.getState().resetKeybinds();
            setProblems({});
          }}
        >
          Reset all
        </Button>
      </div>
      {[...groups].map(([category, list]) => (
        <SettingsSection key={category} title={category}>
          {list.map((command) => {
            const overridden = command.id in overrides;
            const effective = overridden
              ? overrides[command.id] || null
              : (command.keybind ?? null);
            const clash = conflicts.get(command.id);
            const problem = problems[command.id];
            return (
              <SettingRow
                key={command.id}
                id="keybinds.list"
                label={command.title}
                description={
                  [
                    command.owner !== 'core' ? `From ${pluginName(command.owner)}` : null,
                    overridden ? 'Changed' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
                control={(ids) => (
                  <span className={styles.controls}>
                    <KeybindRecorder
                      id={ids.id}
                      aria-describedby={ids.descriptionId}
                      label={`Shortcut for ${command.title}`}
                      value={effective}
                      onRecord={(kb) => {
                        const issue = kb ? keybindProblem(kb, command) : null;
                        setProblems(({ [command.id]: _old, ...rest }) =>
                          issue ? { ...rest, [command.id]: issue } : rest,
                        );
                        if (!issue)
                          stores.settings
                            .getState()
                            .setKeybind(command.id, kb === (command.keybind ?? '') ? null : kb);
                      }}
                    />
                    <span className={styles.resetSlot}>
                      {overridden && (
                        <IconButton
                          size="sm"
                          label={`Reset ${command.title} to default`}
                          icon={<RotateCcw />}
                          onClick={() => {
                            stores.settings.getState().setKeybind(command.id, null);
                          }}
                        />
                      )}
                    </span>
                  </span>
                )}
                noteTone="warning"
                note={
                  problem ? (
                    <>
                      <TriangleAlert size={14} aria-hidden />
                      {problem}
                    </>
                  ) : clash ? (
                    <>
                      <TriangleAlert size={14} aria-hidden />
                      Also used by {clash.map(titleOf).join(', ')}. Only the first one listed runs.
                    </>
                  ) : undefined
                }
              />
            );
          })}
        </SettingsSection>
      ))}
    </>
  );
}
