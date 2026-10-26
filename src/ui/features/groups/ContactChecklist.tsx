import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { fuzzyMatch, initialsFor, type Contact } from '@/core/domain';
import { formatPhone } from '@/ui/features/conversation';
import { Avatar, Checkbox, SearchInput } from '@/ui/primitives';
import styles from './groups.module.css';

export interface ContactChecklistProps {
  /** Who can be picked, in the order to list them. */
  contacts: readonly Contact[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** People who are listed but can't be picked, with the reason shown under their name. */
  unavailable?: Readonly<Record<string, string>>;
  label: string;
  searchLabel: string;
  disabled?: boolean;
  /** The sentence for an empty list. */
  empty: string;
}

/** The contacts that match `query` by name or number, best first (all of them for no query). */
export function filterContacts(contacts: readonly Contact[], query: string): Contact[] {
  const text = query.trim();
  if (!text) return [...contacts];
  const digits = text.replace(/\D/gu, '');
  const scored: { contact: Contact; score: number; order: number }[] = [];
  contacts.forEach((contact, order) => {
    const byName = fuzzyMatch(text, contact.name);
    if (byName) scored.push({ contact, score: byName.score, order });
    else if (
      digits.length >= 3 &&
      /^[\d\s+().-]+$/u.test(text) &&
      contact.number?.replace(/\D/gu, '').includes(digits)
    ) {
      scored.push({ contact, score: 0, order });
    }
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.contact);
}

/**
 * Searchable checklist of contacts: a counted heading, the picks as removable
 * chips under the search field, then the list. Native checkboxes, so every
 * row is reachable and operable by keyboard and screen reader.
 */
export function ContactChecklist({
  contacts,
  selected,
  onChange,
  unavailable = {},
  label,
  searchLabel,
  disabled,
  empty,
}: ContactChecklistProps) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterContacts(contacts, query), [contacts, query]);
  const picked = contacts.filter((c) => selected.has(c.id));

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };

  return (
    <div className={styles.checklist}>
      <div className={styles.checklistHead}>
        <span className={styles.fieldLabel}>{label}</span>
        <span className={styles.count} aria-live="polite">
          {selected.size} selected
        </span>
      </div>
      <SearchInput
        size="sm"
        value={query}
        onValueChange={setQuery}
        placeholder="Search by name or number"
        aria-label={searchLabel}
        disabled={disabled ?? false}
        autoComplete="off"
        spellCheck={false}
      />
      {picked.length > 0 && (
        <ul className={styles.chips} aria-label="Picked people">
          {picked.map((c) => (
            <li key={c.id} className={styles.chip}>
              <span className={styles.chipText}>{c.name}</span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`Remove ${c.name}`}
                disabled={disabled ?? false}
                onClick={() => {
                  toggle(c.id, false);
                }}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className={styles.contactList} aria-label={label}>
        {shown.map((c) => {
          const reason = unavailable[c.id];
          return (
            <li key={c.id}>
              <Checkbox
                className={styles.contactRow}
                checked={selected.has(c.id) || reason !== undefined}
                disabled={(disabled ?? false) || reason !== undefined}
                onCheckedChange={(on) => {
                  toggle(c.id, on);
                }}
              >
                <Avatar
                  size={24}
                  src={c.avatarUrl}
                  fallback={initialsFor(c.name).slice(0, 2)}
                  color={c.color}
                />
                <span className={styles.contactText}>
                  <span className={styles.contactName}>{c.name}</span>
                  {(reason ?? c.number) && (
                    <span className={styles.contactMeta}>
                      {reason ?? formatPhone(c.number ?? '')}
                    </span>
                  )}
                </span>
              </Checkbox>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className={styles.none}>
            {query.trim() ? `Nothing matches “${query.trim()}”.` : empty}
          </li>
        )}
      </ul>
    </div>
  );
}
