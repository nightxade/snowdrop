import { Megaphone, LogOut } from 'lucide-react';
import styles from './GroupNoticeBar.module.css';

/**
 * Stands in for the composer in a group you can't write in: one you left
 * (Desktop's "You are no longer a member of the group."), or an announcement
 * group where only admins send.
 */
export function GroupNoticeBar({ reason }: { reason: 'left' | 'announcement' }) {
  const left = reason === 'left';
  return (
    <section
      className={styles.bar}
      data-snowdrop="message-request"
      data-pane-title={left ? 'left' : 'announcements'}
      data-state={reason}
      aria-label={left ? 'Left group' : 'Announcement group'}
    >
      {left ? <LogOut size={16} aria-hidden /> : <Megaphone size={16} aria-hidden />}
      <p>
        {left
          ? 'You are no longer a member of the group.'
          : 'Only admins can send messages in this group.'}
      </p>
    </section>
  );
}
