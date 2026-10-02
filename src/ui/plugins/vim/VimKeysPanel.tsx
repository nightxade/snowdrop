import { useSyncExternalStore } from 'react';
import { Kbd, VisuallyHidden } from '@/ui/primitives';
import { vimHelp } from './keymap';
import styles from './vim.module.css';

/**
 * Settings → From plugins → Vim keys: the full key map, read-only. Rebinding
 * individual Vim keys isn't supported (the leader key is a setting).
 */
export function makeVimKeysPanel(deps: {
  subscribe: (fn: () => void) => () => void;
  leader: () => string;
}) {
  return function VimKeysPanel() {
    const leader = useSyncExternalStore(deps.subscribe, deps.leader);
    return (
      <div className={styles.panel}>
        <p className={styles.intro}>
          Vim keys work when you aren’t typing, and in the composer’s Normal mode. They can’t be
          rebound one by one; the leader key is a plugin setting.
        </p>
        {vimHelp(leader).map((group) => (
          <section key={group.title} className={styles.group}>
            <h3>{group.title.replace(/^Vim · /u, '')}</h3>
            <dl>
              {group.items.map((item) => (
                <div key={item.title} className={styles.row}>
                  <dt>{item.title}</dt>
                  <dd>
                    {item.keys.split('|').map((keys, n) => (
                      <span key={keys} className={styles.sequence}>
                        {n > 0 && (
                          <span className={styles.or}>
                            <span aria-hidden>/</span>
                            <VisuallyHidden>or</VisuallyHidden>
                          </span>
                        )}
                        {keys.split(' ').map((k, i) => (
                          <Kbd key={`${k}-${i}`} combo={k} />
                        ))}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    );
  };
}
