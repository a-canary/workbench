/**
 * SHA256 Eval Cache
 *
 * Key = SHA256 of genome content (stable, deterministic).
 * Two individuals with identical genomes get the same cache hit,
 * regardless of generation or individual ID.
 *
 * Disable by setting evalCacheEnabled: false in EAConfig.
 */

import * as crypto from 'crypto';
import type { Genome, FitnessResult } from './types.js';

export interface EvalCache {
  get(genome: Genome): FitnessResult | null;
  set(genome: Genome, result: FitnessResult): void;
  clear(): void;
  size(): number;
}

export class SHA256EvalCache implements EvalCache {
  private store = new Map<string, FitnessResult>();

  /** Stable hash — sort keys so identical genomes always hash the same */
  private hash(genome: Genome): string {
    // Sort keys for deterministic serialization
    const content = JSON.stringify(genome, Object.keys(genome).sort());
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  get(genome: Genome): FitnessResult | null {
    return this.store.get(this.hash(genome)) ?? null;
  }

  set(genome: Genome, result: FitnessResult): void {
    this.store.set(this.hash(genome), result);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/** No-op cache — used when evalCacheEnabled = false */
export class NoOpCache implements EvalCache {
  get(): null { return null; }
  set(): void {}
  clear(): void {}
  size(): number { return 0; }
}