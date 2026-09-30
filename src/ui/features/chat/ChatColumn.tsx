import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import { uiSelectors } from '@/core/stores';
import { useKeybindLabel, useShellLayout, useStores } from '@/ui/hooks';
import { useConversationView } from '@/ui/features/conversation';
import { MembersPanel } from '@/ui/features/members';
import { HearthMark, Kbd } from '@/ui/primitives';
import { ChatHeader } from './ChatHeader';
import { ComposerShell } from './ComposerShell';
import { ConnectionBanner } from './ConnectionBanner';
import { MessagePane } from './MessagePane';
import styles from './ChatColumn.module.css';

/**
 * Header across the top; below it the conversation (messages + composer)
 * and, for groups, the member list — inline when wide, a sheet when narrow.
 */
export function ChatColumn() {
  const stores = useStores();
  const { narrow, drawer } = useShellLayout();
  const selected = useStore(stores.ui, uiSelectors.selectedConversation);
  const membersOpen = useStore(stores.ui, uiSelectors.memberListOpen);
  const conversation = useConversationView(selected);
  const showMembers = conversation?.kind === 'group' && membersOpen;

  return (
    <main className={styles.column} data-hearth="chat" aria-label={conversation?.title ?? 'Chat'}>
      {/* With nothing open the header would be an empty bar; keep it only for the drawer button. */}
      {(conversation ?? drawer) && <ChatHeader conversation={conversation} />}
      <ConnectionBanner />
      <div className={styles.body}>
        <div className={styles.conversation}>
          {conversation ? (
            <>
              <MessagePane key={conversation.id} conversation={conversation} />
              <ComposerShell conversation={conversation} />
            </>
          ) : (
            <NothingOpen />
          )}
        </div>
        {showMembers && (
          <>
            {narrow && (
              <button
                type="button"
                className={styles.scrim}
                aria-label="Close member list"
                tabIndex={-1}
                onClick={() => {
                  stores.ui.getState().toggleMemberList(false);
                }}
              />
            )}
            <div className={styles.members} data-sheet={narrow ? '' : undefined}>
              <MembersPanel conversation={conversation} />
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function NothingOpen() {
  const switcher = useKeybindLabel(CoreCommand.QuickSwitcher);
  const next = useKeybindLabel(CoreCommand.NextUnread);
  return (
    <div className={styles.empty}>
      <HearthMark size={56} className={styles.mark} />
      <p className={styles.emptyTitle}>Pick a conversation</p>
      <p className={styles.emptyBody}>Choose one from the list, or jump straight to one.</p>
      <dl className={styles.shortcuts}>
        {switcher && (
          <div>
            <dt>Find a conversation</dt>
            <dd>
              <Kbd combo={switcher} />
            </dd>
          </div>
        )}
        {next && (
          <div>
            <dt>Next unread</dt>
            <dd>
              <Kbd combo={next} />
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
