import { useSyncExternalStore } from 'react';

/** Anything with stable snapshots, e.g. core/lib ObservableList or a registry list. */
export interface ListSource<T> {
  list(): readonly T[];
  subscribe(fn: () => void): () => void;
}

export function useObservableList<T>(source: ListSource<T>): readonly T[] {
  return useSyncExternalStore(
    (fn) => source.subscribe(fn),
    () => source.list(),
  );
}
