import { Ellipsis, Pencil, Puzzle, Reply, RotateCw, SmilePlus, Trash2 } from 'lucide-react';
import { useStore } from 'zustand';
import type { Message } from '@/core/domain';
import { localSelectors } from '@/core/stores';
import { useHearth, useObservableList } from '@/ui/hooks';
import {
  DropdownMenu,
  EmojiPickerPopover,
  IconButton,
  isRenderableComponent,
  PluginBoundary,
  Tooltip,
  type MenuEntry,
} from '@/ui/primitives';
import type { MessagePermissions } from './actions';
import { useShiftHeld } from './useShiftHeld';
import styles from './HoverBar.module.css';

export interface HoverBarProps {
  message: Message;
  permissions: MessagePermissions;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  menu: () => readonly MenuEntry[];
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onRetry: () => void;
  /** Immediate delete (Shift held): for everyone if own, else for me. */
  onQuickDelete: () => void;
}

/** Floating quick actions at a message's top-right (hover or keyboard focus). */
export function HoverBar(props: HoverBarProps) {
  const { message: m, permissions: p } = props;
  const { stores, registries } = useHearth();
  const quick = useStore(stores.local, localSelectors.quickReactions);
  const shift = useShiftHeld();
  const plugins = useObservableList(registries.hoverActions).filter((a) => {
    try {
      return a.visible?.(m) ?? true;
    } catch {
      return false;
    }
  });

  return (
    <div className={styles.bar} role="toolbar" aria-label="Message actions" data-hearth="hover-bar">
      {p.failed ? (
        <IconButton label="Retry sending" icon={<RotateCw />} onClick={props.onRetry} />
      ) : (
        p.canReact && (
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
      {m.kind === 'normal' && !m.deleted && !p.failed && (
        <IconButton label="Reply" icon={<Reply />} onClick={props.onReply} />
      )}
      {p.canEdit && !p.failed && (
        <IconButton label="Edit" icon={<Pencil />} onClick={props.onEdit} />
      )}
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
                try {
                  action.onClick(m);
                } catch (error) {
                  console.error(`[hearth] plugin "${action.owner}" hover action failed`, error);
                }
              }}
            />
          </PluginBoundary>
        );
      })}
      {shift && !p.failed && (p.own || !m.deleted) ? (
        <IconButton
          label={p.own && !m.deleted ? 'Delete for everyone' : 'Delete for me'}
          icon={<Trash2 />}
          className={styles.danger}
          onClick={props.onQuickDelete}
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
