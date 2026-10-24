/**
 * Append-only JSONL Lineage Logger
 *
 * Every event in the EA lifecycle is written to the log as a single-line JSON object.
 * Tools parse "type" + "run_id" to render dashboards, send alerts, or drive pipelines.
 *
 * Log is opened at construction and closed explicitly via close().
 * The log file is created with any missing parent directories.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LogEvent, LogEventType } from './types.js';

export class LineageLogger {
  private fd: number;
  public readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.fd = fs.openSync(logPath, 'a');
  }

  log(event: LogEvent): void {
    fs.writeSync(this.fd, JSON.stringify(event) + '\n');
  }

  /** Write a typed event shorthand */
  write(type: LogEventType, runId: string, extras: Record<string, unknown> = {}): void {
    this.log({ type, run_id: runId, ts: new Date().toISOString(), ...extras });
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}