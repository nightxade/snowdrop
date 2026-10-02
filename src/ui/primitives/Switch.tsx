import * as RadixSwitch from '@radix-ui/react-switch';
import { useId, type ReactNode } from 'react';
import styles from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Accessible name when there's no visible label. */
  ariaLabel?: string;
  /** Use an external <label htmlFor> (settings rows). */
  id?: string;
  'aria-describedby'?: string | undefined;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  ariaLabel,
  id: externalId,
  'aria-describedby': describedBy,
}: SwitchProps) {
  const autoId = useId();
  const id = externalId ?? autoId;
  const control = (
    <RadixSwitch.Root
      id={id}
      className={styles.root}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled ?? false}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
    >
      <RadixSwitch.Thumb className={styles.thumb} />
    </RadixSwitch.Root>
  );
  if (!label) return control;
  return (
    <div className={styles.row}>
      <label htmlFor={id} className={styles.text}>
        <span className={styles.label}>{label}</span>
        {description && <span className={styles.description}>{description}</span>}
      </label>
      {control}
    </div>
  );
}
