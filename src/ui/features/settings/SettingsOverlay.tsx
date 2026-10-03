import { ArrowLeft, Puzzle, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  BREAKPOINTS,
  useMediaQuery,
  useObservableList,
  useRovingFocus,
  useSnowdrop,
} from '@/ui/hooks';
import {
  FullScreenDialog,
  PluginBoundary,
  Scroller,
  SearchInput,
  TooltipProvider,
  isRenderableComponent,
} from '@/ui/primitives';
import {
  DEFAULT_PAGE,
  PAGE_IDS,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  type SettingsGroupId,
  type SettingsPageId,
} from './pages';
import { usePlugins } from './plugins/usePlugins';
import { SettingsFilterProvider, type SettingsFilter } from './rows/SettingsFilter';
import { searchSettings, type SettingsPageMeta } from './search';
import { SettingsPage } from './SettingsPage';
import styles from './SettingsOverlay.module.css';

export interface SettingsOverlayProps {
  onClose: () => void;
  /** Page to open on (deep links: user panel cog, "Rebind in settings"…). */
  initialPage?: string;
}

/** A nav entry: a built-in page, or a panel contributed by a plugin. */
interface NavPage extends SettingsPageMeta {
  group: SettingsGroupId;
  icon: LucideIcon;
  panel?: { id: string; owner: string; component: unknown };
}

const isPageId = (id: string): id is SettingsPageId => (PAGE_IDS as readonly string[]).includes(id);

/**
 * Full-screen settings (PLAN §4.9): grouped nav, search across every page,
 * and live changes (no Save button). Lazy-loaded from the modal host.
 */
export function SettingsOverlay({ onClose, initialPage }: SettingsOverlayProps) {
  const { registries, commands } = useSnowdrop();
  const plugins = usePlugins();
  const panels = useObservableList(registries.settingsPanels);
  const allCommands = useSyncExternalStore(
    (fn) => commands.subscribe(fn),
    () => commands.all(),
  );
  const narrow = useMediaQuery(BREAKPOINTS.drawer);
  const [page, setPage] = useState<string>(() =>
    initialPage && isPageId(initialPage) ? initialPage : DEFAULT_PAGE,
  );
  // On phones the nav is its own screen; picking a page slides to it.
  const [showNav, setShowNav] = useState(initialPage === undefined);
  const [query, setQuery] = useState('');
  // Where focus should go after the next render (phone navigation).
  // A fresh object per request, so the same target can be asked for twice.
  const [focusTo, setFocusTo] = useState<{ to: 'heading' | 'nav' } | null>(null);
  const onNavKeyDown = useRovingFocus('vertical');

  // Plugins, commands (for their shortcuts) and plugin panels are searchable too.
  const pages = useMemo((): NavPage[] => {
    const builtIn = SETTINGS_PAGES.map((p): NavPage => {
      if (p.id === 'plugins')
        return {
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
        };
      if (p.id === 'keybinds')
        return {
          ...p,
          entries: [
            ...p.entries,
            ...allCommands
              .filter((c) => !c.hidden)
              .map((c) => ({
                id: `keybind.${c.id}`,
                label: c.title,
                keywords: [c.category ?? '', 'shortcut', 'keybind'],
              })),
          ],
        };
      return p;
    });
    const panelPages = panels.map((panel): NavPage => ({
      id: `panel:${panel.owner}:${panel.id}`,
      group: 'plugin-panels',
      icon: Puzzle,
      title: panel.title,
      description: `Added by the ${pluginName(panel.owner)} plugin.`,
      entries: [],
      panel,
    }));
    function pluginName(owner: string): string {
      return plugins.find((p) => p.definition.id === owner)?.definition.name ?? owner;
    }
    return [...builtIn, ...panelPages];
  }, [plugins, panels, allCommands]);

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
    return {
      query,
      isVisible: (id) => visible.has(id),
      isSectionVisible: (id) => sections.has(id),
    };
  }, [matches, pages, query]);

  useEffect(() => {
    if (!focusTo) return;
    const target =
      focusTo.to === 'heading'
        ? document.querySelector<HTMLElement>('#snowdrop-settings-main [data-page-heading]')
        : document.querySelector<HTMLElement>(
            `[data-snowdrop="settings"] [data-page-id="${page}"]`,
          );
    target?.focus();
  }, [focusTo, page]);

  const go = (id: string) => {
    setPage(id);
    setQuery('');
    setShowNav(false);
    document.getElementById('snowdrop-settings-main')?.scrollTo({ top: 0 });
    // Phones swap screens: announce the page by landing on its heading.
    if (narrow) setFocusTo({ to: 'heading' });
  };

  const backToNav = () => {
    setShowNav(true);
    setQuery('');
    setFocusTo({ to: 'nav' });
  };

  const renderPage = (meta: NavPage, heading: 'h2' | 'h3'): ReactNode => {
    if (meta.panel) {
      const { panel } = meta;
      const Panel = isRenderableComponent<object>(panel.component) ? panel.component : null;
      return (
        <PageFrame key={meta.id} meta={meta} heading={heading}>
          <PluginBoundary entry={{ id: panel.id, owner: panel.owner, component: panel.component }}>
            {Panel ? <Panel /> : null}
          </PluginBoundary>
        </PageFrame>
      );
    }
    return isPageId(meta.id) ? (
      <PageFrame key={meta.id} meta={meta} heading={heading}>
        <SettingsPage id={meta.id} onNavigate={go} />
      </PageFrame>
    ) : null;
  };

  const current = pages.find((p) => p.id === page) ?? pages[0];
  const matchedIds = new Set(matches?.map((m) => m.pageId) ?? []);

  const backToChats = (
    <button type="button" className={styles.backToChats} onClick={onClose}>
      <ArrowLeft size={16} aria-hidden />
      <span>Back to chats</span>
      <kbd className={styles.escHint} aria-hidden>
        Esc
      </kbd>
    </button>
  );

  return (
    <FullScreenDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Settings"
      initialFocus={narrow && !showNav ? '[data-page-heading]' : 'input[type=search]'}
      className={styles.dialog}
    >
      <TooltipProvider>
        <div
          className={styles.layout}
          data-view={narrow ? (showNav ? 'nav' : 'page') : 'both'}
          data-snowdrop="settings"
        >
          <div className={styles.navColumn}>
            <nav className={styles.nav} aria-label="Settings sections">
              {backToChats}
              <p className={styles.navTitle}>Settings</p>
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
              <Scroller className={styles.navScroller} onKeyDown={onNavKeyDown}>
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
                          const Icon = item.icon;
                          const dim = matches !== null && !matchedIds.has(item.id);
                          return (
                            <li key={item.id}>
                              <button
                                type="button"
                                className={styles.item}
                                data-roving-item
                                data-page-id={item.id}
                                // One tab stop in the nav: the current page; ↑/↓ move.
                                tabIndex={item.id === current?.id ? 0 : -1}
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
          <div
            id="snowdrop-settings-main"
            className={styles.main}
            role="region"
            aria-label="Settings content"
          >
            {narrow && (
              <div className={styles.pageBar}>
                <button type="button" className={styles.back} onClick={backToNav}>
                  <ArrowLeft size={16} aria-hidden />
                  All settings
                </button>
                <button
                  type="button"
                  className={styles.close}
                  onClick={onClose}
                  aria-label="Close settings"
                >
                  <X size={20} aria-hidden />
                </button>
              </div>
            )}
            <div className={styles.mainInner}>
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
          </div>
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
      {/* Not <header>: inside the settings region it would read as a stray banner. */}
      <div className={styles.pageHeader}>
        <H
          className={styles.pageTitle}
          {...(heading === 'h2' ? { tabIndex: -1, 'data-page-heading': '' } : {})}
        >
          {meta.title}
        </H>
        <p className={styles.pageDescription}>{meta.description}</p>
      </div>
      {children}
    </div>
  );
}
