import { Puzzle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState, SearchInput, Segmented, Select } from '@/ui/primitives';
import { useSettingsFilter } from '../rows/SettingsFilter';
import { PluginCard } from './PluginCard';
import { PluginSettingsModal } from './PluginSettingsModal';
import { filterPlugins, usePlugins, type PluginFilter } from './usePlugins';
import styles from './plugins.module.css';

const FILTERS: { value: PluginFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'enabled', label: 'On' },
  { value: 'disabled', label: 'Off' },
];

export function PluginsPage({ initialTag = null }: { initialTag?: string | null }) {
  const all = usePlugins();
  const settingsSearch = useSettingsFilter();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PluginFilter>('all');
  const [tag, setTag] = useState<string | null>(initialTag);
  const [open, setOpen] = useState<string | null>(null);

  const tags = useMemo(
    () => [...new Set(all.flatMap((p) => p.definition.tags ?? []))].sort(),
    [all],
  );
  // The overlay's search narrows the grid too (each plugin is a search entry).
  const searched = all.filter((p) => settingsSearch.isVisible(`plugin.${p.definition.id}`));
  const shown = filterPlugins(searched, { query, filter, tag });
  const enabledCount = all.filter((p) => p.enabled).length;
  const openPlugin = all.find((p) => p.definition.id === open)?.definition;

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <SearchInput
          className={styles.search}
          size="sm"
          value={query}
          onValueChange={setQuery}
          placeholder="Search plugins"
          aria-label="Search plugins"
        />
        <Segmented label="Show" value={filter} options={FILTERS} onValueChange={setFilter} />
        <Select
          aria-label="Filter by tag"
          value={tag ?? ''}
          options={[{ value: '', label: 'All tags' }, ...tags.map((t) => ({ value: t, label: t }))]}
          onValueChange={(v) => {
            setTag(v || null);
          }}
        />
      </div>
      <p className={styles.count} aria-live="polite">
        {enabledCount} of {all.length} on
        {shown.length !== all.length ? ` · showing ${shown.length}` : ''}
      </p>
      {shown.length === 0 ? (
        <EmptyState size="sm" icon={<Puzzle />} title="No plugins match">
          Try another word, or clear the filters.
        </EmptyState>
      ) : (
        <div className={styles.grid}>
          {shown.map((info) => (
            <PluginCard
              key={info.definition.id}
              info={info}
              activeTag={tag}
              onTag={(t) => {
                setTag((current) => (current === t ? null : t));
              }}
              onOpenSettings={() => {
                setOpen(info.definition.id);
              }}
            />
          ))}
        </div>
      )}
      {openPlugin && (
        <PluginSettingsModal
          plugin={openPlugin}
          onClose={() => {
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}
