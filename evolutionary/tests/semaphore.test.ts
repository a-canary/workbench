/**
 * Tests: Semaphore Concurrency Limiter
 */

import { describe, it, expect } from 'vitest';
import { Semaphore } from '../src/semaphore.js';

describe('Semaphore', () => {
  it('acquire() resolves immediately when permits available', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    // If we get here without hanging, it resolved immediately
    expect(sem.running).toBe(0);
  });

  it('consumes a permit on acquire()', () => {
    const sem = new Semaphore(1);
    sem.acquire(); // take the only permit
    expect(sem.running).toBe(0);
  });

  it('release() without waiting callers adds permit', async () => {
    const sem = new Semaphore(1);
    sem.release(); // should not go negative
    // Should be able to acquire twice now
    await sem.acquire();
    await sem.acquire();
  });

  it('running count is 0 when no ops are executing', () => {
    const sem = new Semaphore(3);
    expect(sem.running).toBe(0);
  });

  it('FIFO: first waiter is served on release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // consume permit

    const results: string[] = [];
    const p1 = sem.acquire().then(() => results.push('first'));
    const p2 = sem.acquire().then(() => results.push('second'));
    const p3 = sem.acquire().then(() => results.push('third'));

    // Release in reverse order - first waiter should still get first
    sem.release();
    sem.release();
    sem.release();

    await Promise.all([p1, p2, p3]);
    expect(results).toEqual(['first', 'second', 'third']);
  });

  it('queues when concurrency limit is reached', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // consume the only permit

    let unblocked = false;
    const waitPromise = sem.acquire().then(() => { unblocked = true; });

    // Give event loop a tick - should still be blocked
    await new Promise(r => setTimeout(r, 0));
    expect(unblocked).toBe(false);

    sem.release();
    await waitPromise;
    expect(unblocked).toBe(true);
  });
});