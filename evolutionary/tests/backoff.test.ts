/**
 * Tests: Exponential Backoff with Jitter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sleep, withBackoff, type BackoffOptions } from '../src/backoff.js';

describe('sleep', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves after the specified ms', async () => {
    const p = sleep(100);
    vi.advanceTimersByTime(100);
    await p; // should not throw
  });
});

describe('withBackoff', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const defaultOpts: BackoffOptions = {
    baseMs: 50,
    maxMs: 400,
    maxRetries: 3,
  };

  it('returns result on first success', async () => {
    const spy = vi.fn().mockResolvedValue('ok');
    const p = withBackoff(spy, defaultOpts);
    vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries on failure up to maxRetries', async () => {
    const spy = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValueOnce('ok');

    const p = withBackoff(spy, defaultOpts);
    vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('always fails'));

    const p = withBackoff(spy, defaultOpts);
    vi.runAllTimersAsync();
    await expect(p).rejects.toThrow('always fails');
    expect(spy).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('calls onRetry before each retry', async () => {
    const spy = vi.fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce('ok');

    const onRetry = vi.fn();
    const p = withBackoff(spy, { ...defaultOpts, onRetry });
    vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Number), expect.objectContaining({ message: 'e1' }));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Number), expect.objectContaining({ message: 'e2' }));
  });

  it('delay doubles between retries (exponential)', async () => {
    const delays: number[] = [];
    const spy = vi.fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce('ok');

    const onRetry = (_attempt: number, delayMs: number) => {
      delays.push(delayMs);
    };

    const p = withBackoff(spy, { ...defaultOpts, baseMs: 100, maxMs: 10000, onRetry });
    vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    // first retry ~100ms * 2 = 200ms with jitter
    expect(delays[0]).toBeGreaterThanOrEqual(90); // jitter -10%
    expect(delays[0]).toBeLessThanOrEqual(110);   // jitter +10%
    // second retry ~200ms * 2 = 400ms with jitter
    expect(delays[1]).toBeGreaterThanOrEqual(180);
    expect(delays[1]).toBeLessThanOrEqual(220);
  });

  it('respects maxMs cap', async () => {
    const delays: number[] = [];
    const spy = vi.fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockRejectedValueOnce(new Error('e3'))
      .mockResolvedValueOnce('ok');

    const onRetry = (_attempt: number, delayMs: number) => {
      delays.push(delayMs);
    };

    const p = withBackoff(spy, { baseMs: 200, maxMs: 300, maxRetries: 3, onRetry });
    vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    // All delays should be capped at maxMs (300)
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(300);
    }
  });
});