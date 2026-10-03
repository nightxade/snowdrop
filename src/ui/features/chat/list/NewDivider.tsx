import { memo } from 'react';
import { VisuallyHidden } from '@/ui/primitives';
import styles from './Rows.module.css';

export const NewDivider = memo(function NewDivider() {
  return (
    <div className={styles.new} data-snowdrop="new-divider">
      <span className={styles.newTag}>
        New<VisuallyHidden> messages below</VisuallyHidden>
      </span>
    </div>
  );
});
