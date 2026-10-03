import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useMemo, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { formatKeybind, isMacPlatform, parseKeybind } from '@/core/commands';
import { useSnowdrop } from '@/ui/hooks';
import { Button, IconButton, Kbd } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { KeybindRecorder } from './KeybindRecorder';
import { boundTo, browserReserved, keybindConflicts, keybindProblem, planReassign } from './record';
import styles from './keybinds.module.css';
import { useState } from 'react';

interface PendingReassign {
  commandId: string;
  keybind: string;
  owners: string[];
}

export function KeybindsPage() {
  const { commands, stores, plugins } = useSnowdrop();
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
  const [pending, setPending] = useState<PendingReassign | null>(null);
  const mac = isMacPlatform();
  const display = (kb: string) => {
    const parsed = parseKeybind(kb);
    return parsed ? formatKeybind(parsed, mac) : kb;
  };
  const write = (updates: [string, string | null][]) => {
    for (const [id, kb] of updates) stores.settings.getState().setKeybind(id, kb);
  };
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
        <SettingsSection
          key={category}
          title={category}
          rowIds={list.map((command) => `keybind.${command.id}`)}
        >
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
                id={`keybind.${command.id}`}
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
                        setPending(null);
                        if (issue) return;
                        // Taken by another command: ask before stealing it.
                        const owners = kb ? boundTo(all, overrides, kb, command.id) : [];
                        if (owners.length > 0) {
                          setPending({ commandId: command.id, keybind: kb, owners });
                          return;
                        }
                        write(planReassign(command, kb, []));
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
                  pending?.commandId === command.id ? (
                    <span
                      className={styles.prompt}
                      role="group"
                      aria-label="Shortcut already in use"
                    >
                      <TriangleAlert size={14} aria-hidden />
                      <span className={styles.promptText}>
                        <Kbd combo={display(pending.keybind)} /> is used by{' '}
                        {pending.owners.map(titleOf).join(', ')}. Move it here?
                      </span>
                      <Button
                        size="sm"
                        variant="primary"
                        data-autofocus
                        onClick={() => {
                          write(planReassign(command, pending.keybind, pending.owners));
                          setPending(null);
                        }}
                      >
                        Reassign
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setPending(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : problem ? (
                    <>
                      <TriangleAlert size={14} aria-hidden />
                      {problem}
                    </>
                  ) : clash ? (
                    <>
                      <TriangleAlert size={14} aria-hidden />
                      Also used by {clash.map(titleOf).join(', ')}. Only the first one listed runs.
                    </>
                  ) : effective && browserReserved(effective) ? (
                    <>
                      <TriangleAlert size={14} aria-hidden />
                      {browserReserved(effective)}
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
