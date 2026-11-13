import { Ellipsis, Pencil, Puzzle, Reply, RotateCw, SmilePlus, Trash2 } from 'lucide-react';
import { useStore } from 'zustand';
import { retryCopy, type Message } from '@/core/domain';
import { localSelectors } from '@/core/stores';
import { useSnowdrop, useObservableList } from '@/ui/hooks';
import {
  DropdownMenu,
  EmojiPickerPopover,
  IconButton,
  isRenderableComponent,
  PluginBoundary,
  Tooltip,
  type MenuEntry,
} from '@/ui/primitives';
import {
  messageActionEnabled,
  runMessageAction,
  type ActionContext,
  type MessageActionId,
} from './actions';
import { useShiftHeld } from './useShiftHeld';
import styles from './HoverBar.module.css';

export interface HoverBarProps {
  message: Message;
  /** What the table's actions run with; its `requestDelete` is the immediate (Shift) delete. */
  actions: ActionContext;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  menu: () => readonly MenuEntry[];
  onReact: (emoji: string) => void;
}

/** Floating quick actions at a message's top-right (hover or keyboard focus). */
export function HoverBar(props: HoverBarProps) {
  const { message: m, actions: ctx } = props;
  const p = ctx.p;
  const offers = (id: MessageActionId) => messageActionEnabled(id, p, m);
  const run = (id: MessageActionId) => () => {
    runMessageAction(id, ctx);
  };
  const { stores, registries } = useSnowdrop();
  const quick = useStore(stores.local, localSelectors.quickReactions);
  const shift = useShiftHeld();
  const plugins = useObservableList(registries.hoverActions).filter((a) =>
    registries.isVisible(a, m, 'hover action'),
  );

  return (
    <div
      className={styles.bar}
      role="toolbar"
      aria-label="Message actions"
      data-snowdrop="hover-bar"
    >
      {offers('retry') ? (
        <IconButton label={retryCopy(m).menuLabel} icon={<RotateCw />} onClick={run('retry')} />
      ) : (
        offers('react') && (
          <>
            {quick.map((emoji) => (
              <Tooltip key={emoji} label={`React with ${emoji}`}>
                <button
                  type="button"
                  className={styles.quick}
                  aria-label={`React with ${emoji}`}
                  onClick={() => {
                    props.onReact(emoji);
                  }}
                >
                  {emoji}
                </button>
              </Tooltip>
            ))}
            <EmojiPickerPopover
              open={props.pickerOpen}
              onOpenChange={props.onPickerOpenChange}
              onSelect={props.onReact}
              side="left"
              align="start"
            >
              <IconButton label="Add reaction" icon={<SmilePlus />} active={props.pickerOpen} />
            </EmojiPickerPopover>
            <span className={styles.divider} aria-hidden />
          </>
        )
      )}
      {offers('reply') && <IconButton label="Reply" icon={<Reply />} onClick={run('reply')} />}
      {offers('edit') && <IconButton label="Edit" icon={<Pencil />} onClick={run('edit')} />}
      {plugins.map((action) => {
        const Icon = isRenderableComponent<{ size?: number }>(action.icon) ? action.icon : Puzzle;
        return (
          <PluginBoundary
            key={`${action.owner}:${action.id}`}
            entry={{ id: action.id, owner: action.owner, component: action.icon }}
          >
            <IconButton
              label={action.label}
              icon={<Icon size={20} />}
              onClick={() => {
                registries.invoke(action, 'hover action', () => action.onClick(m));
              }}
            />
          </PluginBoundary>
        );
      })}
      {shift && offers('delete') ? (
        <IconButton
          label={p.canDeleteForEveryone ? 'Delete for everyone' : 'Delete for me'}
          icon={<Trash2 />}
          className={styles.danger}
          onClick={run('delete')}
        />
      ) : (
        <DropdownMenu
          entries={props.menu}
          side="bottom"
          align="end"
          open={props.menuOpen}
          onOpenChange={props.onMenuOpenChange}
          label="More message actions"
        >
          <IconButton label="More" icon={<Ellipsis />} active={props.menuOpen} />
        </DropdownMenu>
      )}
    </div>
  );
}
