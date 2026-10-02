import {
  Accessibility,
  ArrowLeft,
  Bell,
  Braces,
  HardDrive,
  Info,
  Keyboard,
  Paintbrush,
  Palette,
  PlugZap,
  Puzzle,
  Shield,
  SlidersHorizontal,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { BREAKPOINTS, useMediaQuery, useObservableList, useShrike } from '@/ui/hooks';
import {
  FullScreenDialog,
  Kbd,
  PluginBoundary,
  Scroller,
  SearchInput,
  TooltipProvider,
  isRenderableComponent,
} from '@/ui/primitives';
import { DEFAULT_PAGE, SETTINGS_GROUPS, SETTINGS_PAGES } from './pages';
import { usePlugins } from './plugins/usePlugins';
import { SettingsFilterProvider, type SettingsFilter } from './rows/SettingsFilter';
import { searchSettings, type SettingsPageMeta } from './search';
import { SettingsPage } from './SettingsPage';
import styles from './SettingsOverlay.module.css';

const ICONS: Record<string, LucideIcon> = {
  profile: UserRound,
  privacy: Shield,
  appearance: Palette,
  accessibility: Accessibility,
  notifications: Bell,
  keybinds: Keyboard,
  behaviour: SlidersHorizontal,
  plugins: Puzzle,
  themes: Paintbrush,
  quickcss: Braces,
  connection: PlugZap,
  data: HardDrive,
  about: Info,
};

export interface SettingsOverlayProps {
  onClose: () => void;
  /** Page to open on (deep links: user panel cog, "Rebind in settings"…). */
  initialPage?: string;
}

/**
 * Full-screen settings (PLAN §4.9): grouped nav, search across every page,
 * and live changes (no Save button). Lazy-loaded from the modal host.
 */
export function SettingsOverlay({ onClose, initialPage }: SettingsOverlayProps) {
  const { registries } = useShrike();
  const plugins = usePlugins();
  const panels = useObservableList(registries.settingsPanels);
  const narrow = useMediaQuery(BREAKPOINTS.drawer);
  const [page, setPage] = useState(() =>
    initialPage && SETTINGS_PAGES.some((p) => p.id === initialPage) ? initialPage : DEFAULT_PAGE,
  );
  // On phones the nav is its own screen; picking a page slides to it.
  const [showNav, setShowNav] = useState(initialPage === undefined);
  const [query, setQuery] = useState('');

  // Plugins (and plugin panels) are searchable entries too.
  const pages = useMemo((): SettingsPageMeta[] => {
    const withPlugins = SETTINGS_PAGES.map((p) =>
      p.id === 'plugins'
        ? {
            ...p,
            entries: [
              ...p.entries,
              ...plugins.map(({ definition: d }) => ({
                id: `plugin.${d.id}`,
                label: d.name,
                description: d.description,
                keywords: d.tags ?? [],
              })),
            ],
          }
        : p,
    );
    const panelPages = panels.map((panel) => ({
      id: `panel:${panel.owner}:${panel.id}`,
      group: 'plugin-panels',
      title: panel.title,
      description: `Added by the ${panel.owner} plugin.`,
      entries: [],
    }));
    return [...withPlugins, ...panelPages];
  }, [plugins, panels]);

  const matches = useMemo(() => searchSettings(query, pages), [query, pages]);
  const filter = useMemo((): SettingsFilter | null => {
    if (!matches) return null;
    const visible = new Set<string>();
    const sections = new Set<string>();
    for (const m of matches) {
      const meta = pages.find((p) => p.id === m.pageId);
      for (const e of meta?.entries ?? []) {
        if (!m.entryIds.has(e.id)) continue;
        visible.add(e.id);
        if (e.section) sections.add(e.section);
      }
    }
    // Pages without declared entries (plugin panels) are shown whole.
    return {
      query,
      isVisible: (id) => visible.has(id),
      isSectionVisible: (id) => sections.has(id),
    };
  }, [matches, pages, query]);

  const go = (id: string) => {
    setPage(id);
    setQuery('');
    setShowNav(false);
    document.getElementById('shrike-settings-main')?.scrollTo({ top: 0 });
  };

  const renderPage = (meta: SettingsPageMeta, heading: 'h2' | 'h3'): ReactNode => {
    const panel = panels.find((p) => `panel:${p.owner}:${p.id}` === meta.id);
    if (panel) {
      const Panel = isRenderableComponent<object>(panel.component) ? panel.component : null;
      return (
        <PageFrame key={meta.id} meta={meta} heading={heading}>
          <PluginBoundary entry={{ id: panel.id, owner: panel.owner, component: panel.component }}>
            {Panel ? <Panel /> : null}
          </PluginBoundary>
        </PageFrame>
      );
    }
    return (
      <PageFrame key={meta.id} meta={meta} heading={heading}>
        <SettingsPage id={meta.id} onNavigate={go} />
      </PageFrame>
    );
  };

  const current = pages.find((p) => p.id === page) ?? pages[0];
  const matchedIds = new Set(matches?.map((m) => m.pageId) ?? []);

  return (
    <FullScreenDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Settings"
      initialFocus={narrow && !showNav ? undefined : 'input[type=search]'}
      className={styles.dialog}
    >
      <TooltipProvider>
        <div
          className={styles.layout}
          data-view={narrow ? (showNav ? 'nav' : 'page') : 'both'}
          data-shrike="settings"
        >
          <div className={styles.navColumn}>
            <nav className={styles.nav} aria-label="Settings sections">
              <div className={styles.navHeader}>
                <p className={styles.navTitle}>Settings</p>
                {narrow && (
                  <button
                    type="button"
                    className={styles.close}
                    onClick={onClose}
                    aria-label="Close settings"
                  >
                    <X size={20} aria-hidden />
                  </button>
                )}
              </div>
              <SearchInput
                size="sm"
                value={query}
                onValueChange={(v) => {
                  setQuery(v);
                  if (narrow && v) setShowNav(false);
                }}
                placeholder="Search settings"
                aria-label="Search settings"
              />
              <Scroller className={styles.navScroller}>
                {SETTINGS_GROUPS.map((group) => {
                  const items = pages.filter((p) => p.group === group.id);
                  if (items.length === 0) return null;
                  return (
                    <div
                      key={group.id}
                      className={styles.group}
                      role="group"
                      aria-labelledby={`settings-group-${group.id}`}
                    >
                      <p id={`settings-group-${group.id}`} className={styles.groupTitle}>
                        {group.title}
                      </p>
                      <ul className={styles.items}>
                        {items.map((item) => {
                          const Icon = ICONS[item.id] ?? Puzzle;
                          const dim = matches !== null && !matchedIds.has(item.id);
                          return (
                            <li key={item.id}>
                              <button
                                type="button"
                                className={styles.item}
                                aria-current={!matches && item.id === page ? 'page' : undefined}
                                data-dim={dim ? '' : undefined}
                                onClick={() => {
                                  go(item.id);
                                }}
                              >
                                <Icon size={18} aria-hidden />
                                {item.title}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </Scroller>
            </nav>
          </div>
          <main id="shrike-settings-main" className={styles.main} aria-label="Settings content">
            <div className={styles.mainInner}>
              {narrow && (
                <button
                  type="button"
                  className={styles.back}
                  onClick={() => {
                    setShowNav(true);
                    setQuery('');
                  }}
                >
                  <ArrowLeft size={16} aria-hidden />
                  All settings
                </button>
              )}
              <SettingsFilterProvider value={filter}>
                {matches === null ? (
                  current && renderPage(current, 'h2')
                ) : matches.length === 0 ? (
                  <div className={styles.noResults} role="status">
                    <p className={styles.noResultsTitle}>No settings match “{query}”</p>
                    <p>Try a different word, like “theme”, “mentions” or “shortcut”.</p>
                  </div>
                ) : (
                  <>
                    <p className={styles.resultsTitle} role="status">
                      Results for “{query}”
                    </p>
                    {matches.map((m) => {
                      const meta = pages.find((p) => p.id === m.pageId);
                      return meta ? (
                        <section key={meta.id} className={styles.resultBlock}>
                          {renderPage(meta, 'h3')}
                        </section>
                      ) : null;
                    })}
                  </>
                )}
              </SettingsFilterProvider>
            </div>
            {!narrow && (
              <div className={styles.closeColumn}>
                <button
                  type="button"
                  className={styles.close}
                  onClick={onClose}
                  aria-label="Close settings"
                >
                  <X size={20} aria-hidden />
                </button>
                <Kbd combo="Esc" className={styles.closeHint} />
              </div>
            )}
          </main>
        </div>
      </TooltipProvider>
    </FullScreenDialog>
  );
}

function PageFrame({
  meta,
  heading,
  children,
}: {
  meta: SettingsPageMeta;
  heading: 'h2' | 'h3';
  children: ReactNode;
}) {
  const H = heading;
  return (
    <div className={styles.page} data-settings-page={meta.id}>
      <header className={styles.pageHeader}>
        <H className={styles.pageTitle}>{meta.title}</H>
        <p className={styles.pageDescription}>{meta.description}</p>
      </header>
      {children}
    </div>
  );
}
