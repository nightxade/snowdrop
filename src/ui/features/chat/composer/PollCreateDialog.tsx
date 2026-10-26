import { X } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { graphemes, POLL_LIMITS, type PollDraftProblem } from '@/core/lib';
import { Button, IconButton, Modal, Switch, TextInput } from '@/ui/primitives';
import {
  checkPollDraft,
  clampGraphemes,
  editOption,
  pollDraftStarted,
  POLL_PROBLEM_TEXT,
  removeOption,
  type PollDraft,
} from './pollDraft';
import styles from './PollCreateDialog.module.css';

export interface PollCreateDialogProps {
  draft: PollDraft;
  onDraftChange: (draft: PollDraft) => void;
  /** A valid poll, ready to send. The dialog doesn't close itself: the caller does once it has sent. */
  onSend: (poll: { question: string; options: string[]; allowMultiple: boolean }) => void;
  onClose: () => void;
}

/** Near the limit, how many characters are left shows (Signal Desktop's last 30). */
const COUNT_FROM = 30;

/**
 * "New poll": a question, up to ten options and whether people may choose
 * more than one. Limits and wording are Signal Desktop's. The option list
 * grows and shrinks as you type (see `editOption`); Enter in an option moves
 * to the next, and Ctrl/Cmd+Enter sends from anywhere. Send is off until
 * something is typed; sending an incomplete poll says what is missing and
 * puts the cursor there.
 */
export function PollCreateDialog({ draft, onDraftChange, onSend, onClose }: PollCreateDialogProps) {
  const [problem, setProblem] = useState<PollDraftProblem | null>(null);
  const questionRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<number, HTMLInputElement>());
  const errorId = useId();
  const optionsId = useId();
  const questionLeft = POLL_LIMITS.questionGraphemes - graphemes(draft.question).length;

  const focusOption = (index: number) => {
    const row = draft.options[Math.max(0, Math.min(index, draft.options.length - 1))];
    if (row) optionRefs.current.get(row.key)?.focus();
  };

  const change = (next: PollDraft) => {
    onDraftChange(next);
    setProblem(null);
  };

  const send = () => {
    const checked = checkPollDraft(draft);
    if (checked.ok) {
      onSend(checked.poll);
      return;
    }
    setProblem(checked.problem);
    // Straight to what needs fixing.
    if (checked.problem === 'question-missing' || checked.problem === 'question-too-long')
      questionRef.current?.focus();
    else focusOption(draft.options.findIndex((o) => o.text.trim() === ''));
  };

  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>, next: () => void) => {
    if (e.nativeEvent.isComposing || e.key !== 'Enter') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) send();
    else next();
  };

  const questionInvalid = problem === 'question-missing' || problem === 'question-too-long';
  const optionsInvalid = problem !== null && !questionInvalid;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="md"
      title="New poll"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!pollDraftStarted(draft)} onClick={send}>
            Send
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        data-snowdrop="poll-create"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <TextInput
          ref={questionRef}
          label="Question"
          placeholder="Ask a question"
          value={draft.question}
          autoComplete="off"
          onChange={(e) => {
            change({
              ...draft,
              question: clampGraphemes(e.target.value, POLL_LIMITS.questionGraphemes),
            });
          }}
          onKeyDown={(e) => {
            onFieldKeyDown(e, () => {
              focusOption(0);
            });
          }}
          {...(questionLeft <= COUNT_FROM ? { hint: `${questionLeft} characters left` } : {})}
          {...(questionInvalid ? { error: POLL_PROBLEM_TEXT[problem] } : {})}
        />
        <fieldset
          className={styles.options}
          aria-describedby={optionsInvalid ? errorId : undefined}
        >
          <legend className={styles.legend} id={optionsId}>
            Options
          </legend>
          {draft.options.map((option, index) => {
            const left = POLL_LIMITS.optionUnits - option.text.length;
            // The trailing blank row is the one to type into; only rows with something to lose get a button.
            const removable =
              draft.options.length > POLL_LIMITS.minOptions && option.text.trim() !== '';
            return (
              <div key={option.key} className={styles.row}>
                <TextInput
                  className={styles.option}
                  ref={(el) => {
                    if (el) optionRefs.current.set(option.key, el);
                    else optionRefs.current.delete(option.key);
                  }}
                  aria-label={`Option ${index + 1}`}
                  placeholder={`Option ${index + 1}`}
                  value={option.text}
                  autoComplete="off"
                  aria-invalid={optionsInvalid && option.text.trim() === '' ? true : undefined}
                  onChange={(e) => {
                    const result = editOption(draft, option.key, e.target.value);
                    change(result.draft);
                    if (result.removed !== undefined) {
                      const target =
                        result.draft.options[
                          Math.min(result.removed, result.draft.options.length - 1)
                        ];
                      // After React has rendered the shortened list.
                      if (target)
                        requestAnimationFrame(() => {
                          optionRefs.current.get(target.key)?.focus();
                        });
                    }
                  }}
                  onKeyDown={(e) => {
                    onFieldKeyDown(e, () => {
                      focusOption(index + 1);
                    });
                  }}
                  {...(left <= COUNT_FROM ? { hint: `${left} characters left` } : {})}
                />
                {!removable && <span className={styles.remove} aria-hidden />}
                {removable && (
                  <IconButton
                    label={`Remove option ${index + 1}`}
                    icon={<X />}
                    className={styles.remove}
                    onClick={() => {
                      const result = removeOption(draft, option.key);
                      change(result.draft);
                      if (result.removed !== undefined) {
                        const target =
                          result.draft.options[
                            Math.min(result.removed, result.draft.options.length - 1)
                          ];
                        requestAnimationFrame(() => {
                          if (target) optionRefs.current.get(target.key)?.focus();
                        });
                      }
                    }}
                  />
                )}
              </div>
            );
          })}
        </fieldset>
        <Switch
          label="Allow multiple votes"
          checked={draft.allowMultiple}
          onCheckedChange={(allowMultiple) => {
            change({ ...draft, allowMultiple });
          }}
        />
        {optionsInvalid && (
          <p className={styles.error} id={errorId} role="alert">
            {POLL_PROBLEM_TEXT[problem]}
          </p>
        )}
      </form>
    </Modal>
  );
}
