import { ConversationList } from './ConversationList';
import { SidebarHeader } from './SidebarHeader';
import { UserPanel } from './UserPanel';
import styles from './Sidebar.module.css';

export function Sidebar() {
  return (
    <aside className={styles.sidebar} data-snowdrop="sidebar" data-pane-title="chats">
      <SidebarHeader />
      <ConversationList />
      <UserPanel />
    </aside>
  );
}
