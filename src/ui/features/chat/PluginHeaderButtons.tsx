import { Puzzle } from 'lucide-react';
import type { ConversationView } from '@/core/domain';
import { useShrike, useObservableList } from '@/ui/hooks';
import { IconButton, isRenderableComponent, PluginBoundary } from '@/ui/primitives';

/** Header buttons contributed by plugins (ctx.headerBar.addButton), each isolated. */
export function PluginHeaderButtons({ conversation }: { conversation: ConversationView }) {
  const { registries } = useShrike();
  const buttons = useObservableList(registries.headerButtons);
  const visible = buttons.filter((b) => {
    try {
      return b.visible?.(conversation) ?? true;
    } catch {
      return false;
    }
  });
  if (visible.length === 0) return null;
  return (
    <span data-slot="chat.header.buttons" style={{ display: 'contents' }}>
      {visible.map((button) => {
        const Icon = isRenderableComponent<{ size?: number }>(button.icon) ? button.icon : Puzzle;
        return (
          <PluginBoundary
            key={`${button.owner}:${button.id}`}
            entry={{ id: button.id, owner: button.owner, component: button.icon }}
          >
            <IconButton
              label={button.label}
              icon={<Icon size={20} />}
              onClick={() => {
                try {
                  button.onClick(conversation);
                } catch (error) {
                  console.error(`[shrike] plugin "${button.owner}" header button failed`, error);
                }
              }}
            />
          </PluginBoundary>
        );
      })}
    </span>
  );
}
