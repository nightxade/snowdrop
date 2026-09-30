import { ConversationList } from './ConversationList';
import { SidebarHeader } from './SidebarHeader';
import { UserPanel } from './UserPanel';
import styles from './Sidebar.module.css';

export function Sidebar() {
  return (
    <aside className={styles.sidebar} data-hearth="sidebar">
      <SidebarHeader />
      <ConversationList />
      <UserPanel />
    </aside>
  );
}
