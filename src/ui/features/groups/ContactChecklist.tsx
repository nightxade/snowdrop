import { X } from 'lucide-react';
import { useMemo, useState, type Ref } from 'react';
import { fuzzyMatch, initialsFor, type Contact } from '@/core/domain';
import { formatPhone, PersonAvatar } from '@/ui/features/conversation';
import { Checkbox, SearchInput } from '@/ui/primitives';
import { VirtualList } from '@/ui/primitives/VirtualList';
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
  /** The search field, for a caller that moves focus to it. */
  searchRef?: Ref<HTMLInputElement> | undefined;
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
  searchRef,
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
        ref={searchRef}
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
      {shown.length > 0 ? (
        <VirtualList
          tag="ul"
          className={styles.contactList}
          aria-label={label}
          count={shown.length}
          rowHeight={44}
          maxHeight="min(320px, 40vh)"
          itemKey={(index) => shown[index]?.id ?? String(index)}
          itemContent={(index) => {
            const c = shown[index];
            if (!c) return null;
            const reason = unavailable[c.id];
            return (
              <Checkbox
                className={styles.contactRow}
                checked={selected.has(c.id) || reason !== undefined}
                disabled={(disabled ?? false) || reason !== undefined}
                onCheckedChange={(on) => {
                  toggle(c.id, on);
                }}
              >
                <PersonAvatar
                  size={24}
                  contactId={c.id}
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
            );
          }}
        />
      ) : (
        <ul className={styles.contactList} aria-label={label}>
          <li className={styles.none}>
            {query.trim() ? `Nothing matches “${query.trim()}”.` : empty}
          </li>
        </ul>
      )}
    </div>
  );
}
