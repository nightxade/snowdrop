import { createContext, use, type ReactNode } from 'react';

/** Responsive layout state shared by the shell and the regions inside it. */
export interface ShellLayout {
  /** < 1100px: the member list is an overlay sheet. */
  narrow: boolean;
  /** < 760px: rail + sidebar live in a slide-over drawer. */
  drawer: boolean;
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
}

const DEFAULT: ShellLayout = {
  narrow: false,
  drawer: false,
  navOpen: false,
  setNavOpen: () => undefined,
};

const ShellLayoutContext = createContext<ShellLayout>(DEFAULT);

export function ShellLayoutProvider({
  value,
  children,
}: {
  value: ShellLayout;
  children: ReactNode;
}) {
  return <ShellLayoutContext value={value}>{children}</ShellLayoutContext>;
}

export function useShellLayout(): ShellLayout {
  return use(ShellLayoutContext);
}
