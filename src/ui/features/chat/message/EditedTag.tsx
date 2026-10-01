import { useStore } from 'zustand';
import { formatFullTimestamp } from '@/core/domain';
import { useHearth } from '@/ui/hooks';
import { Tooltip } from '@/ui/primitives';
import styles from './MessageMeta.module.css';

/** "(edited)" with the edit time on hover; sits inline after the text. */
export function EditedTag({ editedAt }: { editedAt: number }) {
  const { stores } = useHearth();
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  return (
    <Tooltip label={`Edited ${formatFullTimestamp(editedAt, { clock24h })}`}>
      <span className={styles.edited} tabIndex={0}>
        (edited)
      </span>
    </Tooltip>
  );
}
