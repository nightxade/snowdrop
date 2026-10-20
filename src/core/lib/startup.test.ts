import { afterEach, describe, expect, it, vi } from 'vitest';
import { markStartup, resetStartupMarks, setStartupSink } from './startup';

describe('startup marks', () => {
  afterEach(() => {
    resetStartupMarks();
    vi.restoreAllMocks();
  });

  it('replays earlier marks to a late sink and forwards later ones', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(120.4);
    markStartup('first');
    const sink = vi.fn();
    setStartupSink(sink);
    expect(sink).toHaveBeenCalledWith('first', 120);
    now.mockReturnValue(300.6);
    markStartup('second');
    expect(sink).toHaveBeenLastCalledWith('second', 301);
  });

  it('records each phase only once', () => {
    const sink = vi.fn();
    setStartupSink(sink);
    markStartup('once');
    markStartup('once');
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
