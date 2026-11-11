import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureStore } from '@/core/backend/features';
import { bootSnowdrop, renderWithSnowdrop } from '@/test/renderWithSnowdrop';
import { useBackendFeature } from './useBackendFeature';

function Probe() {
  return <output>{useBackendFeature('readSync') ? 'on' : 'off'}</output>;
}

afterEach(cleanup);

describe('useBackendFeature', () => {
  it('re-renders when the backend gains or loses the feature', async () => {
    const snowdrop = await bootSnowdrop();
    const store = new FeatureStore();
    (snowdrop.backend as unknown as { capabilities: FeatureStore }).capabilities = store;
    renderWithSnowdrop(snowdrop, <Probe />);
    expect(screen.getByRole('status').textContent).toBe('off');
    act(() => {
      store.setFeature('readSync', true);
    });
    expect(screen.getByRole('status').textContent).toBe('on');
    act(() => {
      store.setFeature('readSync', false);
    });
    expect(screen.getByRole('status').textContent).toBe('off');
  });
});
