import fs from 'fs/promises'
import fsSync from 'fs'
import readline from 'readline'

export interface Event {
  id: string
  type: string
  status: 'open' | 'resolved' | 'archived'
  ts: number
  [key: string]: unknown
}

export class JsonlDb {
  constructor(private path: string) {}

  async append(event: Event): Promise<void> {
    await fs.appendFile(this.path, JSON.stringify(event) + '\n', 'utf8')
  }

  async query(predicate: (e: Event) => boolean): Promise<Event[]> {
    const lines = await this.readLines()
    return lines.filter(predicate)
  }

  async update(id: string, patch: Partial<Event>): Promise<void> {
    const lines = await this.readLines()
    const updated = lines.map(e => (e.id === id ? { ...e, ...patch } : e))
    await fs.writeFile(this.path, updated.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  }

  async gc(
    resolvePredicate: (e: Event) => boolean,
    archivePath?: string
  ): Promise<{ kept: number; archived: number }> {
    const lines = await this.readLines()
    const kept = lines.filter(e => !resolvePredicate(e))
    const archived = lines.filter(resolvePredicate)
    await fs.writeFile(this.path, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8')
    if (archivePath && archived.length) {
      await fs.appendFile(archivePath, archived.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    }
    return { kept: kept.length, archived: archived.length }
  }

  watch(cb: (event: Event) => void): () => void {
    let size = 0
    try { size = fsSync.statSync(this.path).size } catch { /* file may not exist yet */ }
    const watcher = fsSync.watch(this.path, async () => {
      try {
        const stat = fsSync.statSync(this.path)
        if (stat.size <= size) return
        const fd = await fs.open(this.path, 'r')
        const buf = Buffer.alloc(stat.size - size)
        await fd.read(buf, 0, buf.length, size)
        await fd.close()
        size = stat.size
        buf.toString('utf8').split('\n').filter(Boolean).forEach(line => {
          try { cb(JSON.parse(line) as Event) } catch { /* skip malformed */ }
        })
      } catch { /* ignore transient errors */ }
    })
    return () => watcher.close()
  }

  private async readLines(): Promise<Event[]> {
    const events: Event[] = []
    try {
      const rl = readline.createInterface({ input: fsSync.createReadStream(this.path), crlfDelay: Infinity })
      for await (const line of rl) {
        if (line.trim()) {
          try { events.push(JSON.parse(line) as Event) } catch { /* skip malformed */ }
        }
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    return events
  }
}

// --- self-check: `bun skills/jsonl-db/lib/jsonl-db.ts` (stdlib only, no fixtures) ---
if ((import.meta as { main?: boolean }).main) {
  const { default: assert } = await import('node:assert/strict')
  const dir = `/tmp/jsonl-db-selfcheck-${process.pid}`
  fsSync.mkdirSync(dir, { recursive: true })
  try {
    const db = new JsonlDb(`${dir}/tasks.jsonl`)
    const archive = `${dir}/archive.jsonl`
    await db.append({ id: 'evt_01', type: 'task.created', status: 'open', ts: 1 })
    await db.append({ id: 'evt_02', type: 'task.created', status: 'resolved', ts: 2 })
    assert.equal((await db.query(e => e.status === 'open')).length, 1)
    await db.update('evt_01', { status: 'resolved' })
    assert.deepEqual(await db.gc(e => e.status === 'resolved', archive), { kept: 0, archived: 2 })
    assert.equal((await fs.readFile(archive, 'utf8')).trim().split('\n').length, 2)
    const seen: string[] = []
    const stop = db.watch(e => seen.push(e.id))
    await db.append({ id: 'evt_03', type: 'task.created', status: 'open', ts: 3 })
    const t0 = Date.now()
    while (seen.length === 0 && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 20))
    stop()
    assert.deepEqual(seen, ['evt_03'])
    console.log('jsonl-db self-check OK')
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true })
  }
}
