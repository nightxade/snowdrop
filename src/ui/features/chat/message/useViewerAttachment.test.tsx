import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageRef } from '@/core/backend';
import { FeatureStore } from '@/core/backend/features';
import type { Attachment, ConversationId } from '@/core/domain';
import { createStores } from '@/core/stores';
import { SnowdropContextProvider, type AppServices } from '@/ui/hooks';
import { useViewerAttachment } from './useViewerAttachment';

const conversationId = 'conv' as ConversationId;
const message: MessageRef = { authorId: 'me', sentAt: 1 };
const preview: Attachment = {
  id: 'local:1',
  contentType: 'image/png',
  url: 'data:image/webp;base64,AAAA',
  original: true,
};

let created: string[];
let revoked: string[];
beforeEach(() => {
  created = [];
  revoked = [];
  let n = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: () => {
        const url = `blob:original-${++n}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Seen = ReturnType<typeof useViewerAttachment>;

function mount(
  attachment: Attachment,
  readSentMedia: (id: string, type: string) => Promise<Blob | undefined>,
  active = true,
) {
  const seen: { current: Seen | null } = { current: null };
  function Probe({ on, a }: { on: boolean; a: Attachment }) {
    seen.current = useViewerAttachment(conversationId, message, a, [a.id], on);
    return null;
  }
  const app = {
    backend: { kind: 'signal-cli', capabilities: new FeatureStore() },
    stores: createStores(),
    repository: { readSentMedia },
  } as unknown as AppServices;
  const ui = (on: boolean, a: Attachment) => (
    <SnowdropContextProvider value={app}>
      <Probe on={on} a={a} />
    </SnowdropContextProvider>
  );
  const view = render(ui(active, attachment));
  return { seen, view, ui };
}

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe('useViewerAttachment', () => {
  it('shows the preview first, then the kept original once it is read', async () => {
    const read = vi.fn().mockResolvedValue(new Blob(['full']));
    const { seen } = mount(preview, read);
    expect(seen.current).toMatchObject({ status: 'ready', url: preview.url });
    await settle();
    expect(read).toHaveBeenCalledWith('local:1', 'image/png');
    expect(seen.current).toMatchObject({ status: 'ready', url: 'blob:original-1' });
  });

  it('holds the original only while the viewer is open', async () => {
    const read = vi.fn().mockResolvedValue(new Blob(['full']));
    const { seen, view, ui } = mount(preview, read);
    await settle();
    view.rerender(ui(false, preview));
    expect(revoked).toEqual(['blob:original-1']);
    expect(seen.current).toMatchObject({ url: preview.url });
  });

  it('releases the previous original when another image is selected', async () => {
    const read = vi.fn().mockResolvedValue(new Blob(['full']));
    const { seen, view, ui } = mount(preview, read);
    await settle();
    view.rerender(ui(true, { ...preview, id: 'local:2' }));
    expect(revoked).toContain('blob:original-1');
    await settle();
    expect(seen.current).toMatchObject({ url: 'blob:original-2' });
  });

  it('falls back to the preview when the original cannot be shown or read', async () => {
    const read = vi.fn().mockResolvedValue(new Blob(['full']));
    const { seen } = mount(preview, read);
    await settle();
    act(() => {
      seen.current?.onMediaError();
    });
    expect(seen.current).toMatchObject({ status: 'ready', url: preview.url });

    const failing = mount({ ...preview, id: 'local:3' }, () => Promise.reject(new Error('x')));
    await settle();
    expect(failing.seen.current).toMatchObject({ status: 'ready', url: preview.url });
  });

  it('never reads for an image with no kept original', async () => {
    const read = vi.fn();
    const { seen } = mount({ id: 'x', contentType: 'image/png', url: 'blob:r' }, read);
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(seen.current).toMatchObject({ url: 'blob:r' });
  });
});
