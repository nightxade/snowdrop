import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { addLogSink, createLogger, recentLogLines, type LogLevel } from './log';

describe('createLogger', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;
  let warnSpy: MockInstance<(...args: unknown[]) => void>;
  let infoSpy: MockInstance<(...args: unknown[]) => void>;
  let debugSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes each level to its matching console method, prefixed with the scope', () => {
    const log = createLogger('sync-level-test');
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(errorSpy).toHaveBeenCalledWith('[sync-level-test] e');
    expect(warnSpy).toHaveBeenCalledWith('[sync-level-test] w');
    expect(infoSpy).toHaveBeenCalledWith('[sync-level-test] i');
    expect(debugSpy).toHaveBeenCalledWith('[sync-level-test] d');
  });

  it('formats an Error detail as "name: message" plus its stack', () => {
    const log = createLogger('err-format-test');
    const error = new TypeError('boom');
    log.error('failed', error);
    const [line] = errorSpy.mock.calls[0] as [string];
    expect(line).toContain('TypeError: boom');
    if (error.stack) expect(line).toContain(error.stack);
  });

  it('formats a non-Error detail as a plain value, without raising', () => {
    const log = createLogger('detail-format-test');
    log.warn('count', { count: 3 });
    expect(warnSpy).toHaveBeenCalledWith('[detail-format-test] count {"count":3}');
  });

  it('omits the detail entirely when none is given', () => {
    const log = createLogger('no-detail-test');
    log.info('just a message');
    expect(infoSpy).toHaveBeenCalledWith('[no-detail-test] just a message');
  });

  it('sends every level to additional sinks, and a throwing sink never breaks logging', () => {
    const calls: { level: LogLevel; scope: string; message: string }[] = [];
    const remove = addLogSink({
      write: (level, scope, message) => {
        calls.push({ level, scope, message });
      },
    });
    const throwingRemove = addLogSink({
      write: () => {
        throw new Error('sink exploded');
      },
    });
    const log = createLogger('sink-test');
    expect(() => {
      log.warn('hello');
    }).not.toThrow();
    expect(calls).toEqual([{ level: 'warn', scope: 'sink-test', message: 'hello' }]);
    // console.warn still ran despite the throwing sink.
    expect(warnSpy).toHaveBeenCalledWith('[sink-test] hello');
    remove();
    throwingRemove();
  });

  it('a removed sink stops receiving lines', () => {
    const calls: string[] = [];
    const remove = addLogSink({
      write: (_level, _scope, message) => {
        calls.push(message);
      },
    });
    const log = createLogger('remove-sink-test');
    log.info('first');
    remove();
    log.info('second');
    expect(calls).toEqual(['first']);
  });
});

describe('recentLogLines (ring buffer)', () => {
  it('caps at ~200 lines, dropping the oldest first', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const log = createLogger('ring-test');
    for (let i = 0; i < 250; i++) log.info(`line-${i}`);
    infoSpy.mockRestore();
    const lines = recentLogLines();
    expect(lines.length).toBeLessThanOrEqual(200);
    const joined = lines.join('\n');
    expect(joined).not.toContain('line-0\n');
    expect(joined.endsWith('line-0')).toBe(false);
    expect(joined).toContain('line-249');
  });
});
