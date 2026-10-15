import { ConversationList } from './ConversationList';
import { SidebarHeader } from './SidebarHeader';
import { UserPanel } from './UserPanel';
import styles from './Sidebar.module.css';

/**
 * `.wrap` carries the standard shell's width/background/height (unchanged
 * look); the aside and the user panel are separate elements only so the TUI
 * shell (tui.css) can box them as two stacked panes ("chats" and "you")
 * without nesting one inside the other — in the standard shell `.sidebar`
 * and `[data-snowdrop='user-panel']` just stack in `.wrap`'s flex column as
 * they always have.
 */
export function Sidebar() {
  return (
    <div className={styles.wrap}>
      <aside className={styles.sidebar} data-snowdrop="sidebar" data-pane-title="chats">
        <SidebarHeader />
        <ConversationList />
      </aside>
      <UserPanel />
    </div>
  );
}
