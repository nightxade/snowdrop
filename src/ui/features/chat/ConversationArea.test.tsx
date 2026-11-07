import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationId } from '@/core/domain';
import { createStores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { ConversationArea } from './ConversationArea';
import { voicePlayback } from './voice/voicePlayback';

vi.mock('./MessagePane', () => ({ MessagePane: () => null }));
vi.mock('./composer/Composer', () => ({ Composer: () => null }));
vi.mock('./ChatController', () => ({ useChatController: () => ({}) }));
vi.mock('@/ui/features/conversation', () => ({ useMessageRequestState: () => 'accepted' }));

afterEach(cleanup);

describe('ConversationArea', () => {
  it('leaves the playing voice note alone when the conversation closes (the mini player owns it)', () => {
    const stop = vi.spyOn(voicePlayback, 'stop');
    const app = { stores: createStores() } as unknown as AppServices;
    const view = render(
      <SnowdropContextProvider value={app}>
        <ConversationArea conversationId={'c' as ConversationId} />
      </SnowdropContextProvider>,
    );
    stop.mockClear();
    view.unmount();
    expect(stop).not.toHaveBeenCalled();
    stop.mockRestore();
  });
});
