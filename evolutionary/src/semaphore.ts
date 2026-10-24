/**
 * Concurrency Limiter (Semaphore)
 *
 * Limits the number of concurrent operations without external dependencies.
 * Uses a FIFO queue — no starvation, predictable ordering.
 *
 * Used to limit parallel evaluation (evalConcurrency) and
 * parallel breeding (breedConcurrency) independently.
 */

export class Semaphore {
  private queue: Array<() => void> = [];
  private _permits: number;

  constructor(permits: number) {
    this._permits = permits;
  }

  async acquire(): Promise<void> {
    if (this._permits > 0) {
      this._permits--;
      return;
    }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    this._permits++;
    const next = this.queue.shift();
    if (next) {
      this._permits--;
      next();
    }
  }

  /** Number of operations currently running */
  get running(): number {
    return this._permits < 0 ? -this._permits : 0;
  }
}