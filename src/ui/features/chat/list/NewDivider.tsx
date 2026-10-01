import { memo } from 'react';
import styles from './Rows.module.css';

export const NewDivider = memo(function NewDivider() {
  return (
    <div
      className={styles.new}
      role="separator"
      aria-label="New messages"
      data-hearth="new-divider"
    >
      <span className={styles.newTag}>New</span>
    </div>
  );
});
