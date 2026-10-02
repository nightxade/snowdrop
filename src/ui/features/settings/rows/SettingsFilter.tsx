import { createContext, use, type ReactNode } from 'react';

export interface SettingsFilter {
  /** Whether a row (entry id) should render under the current search. */
  isVisible(entryId: string): boolean;
  isSectionVisible(sectionId: string): boolean;
  /** The active search text ('' when not searching). */
  query: string;
}

const ALL: SettingsFilter = { isVisible: () => true, isSectionVisible: () => true, query: '' };

const Context = createContext<SettingsFilter>(ALL);

export function SettingsFilterProvider({
  value,
  children,
}: {
  value: SettingsFilter | null;
  children: ReactNode;
}) {
  return <Context value={value ?? ALL}>{children}</Context>;
}

export function useSettingsFilter(): SettingsFilter {
  return use(Context);
}
