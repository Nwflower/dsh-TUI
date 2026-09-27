/**
 * Foreign-session catalog: what the session screen's source tabs browse.
 *
 * Two questions, both answered stale-while-revalidate:
 *
 * - **Which sources have data?** {@link ForeignCatalog.refreshSources} walks
 *   each browsable source by name alone (the adapter's {@link WalkSpec}),
 *   counting candidates and taking the newest mtime. Sources with nothing
 *   are hidden; the rest sort by newest activity.
 * - **Which conversations does a source hold?** {@link ForeignCatalog.refreshSessions}
 *   runs the adapter's summary scan, reusing every summary whose artifact
 *   fingerprint is unchanged, so a warm rescan reads almost nothing.
 *
 * Both answers persist to one snapshot file, so the next time the screen
 * opens the tabs and lists paint from disk at once and are then refreshed
 * in the background. A late refresh never overwrites a newer one
 * (per-source generation guard), and a damaged snapshot reads as empty.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/catalog
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from '../../utils/paths.js'
import { fingerprintOf, walkFiles } from './adapters/scan-fs.js'
import type { Fingerprint, ForeignSessionSummary, MigrationAdapter } from './types.js'

/** Default snapshot location. */
export const FOREIGN_CATALOG_FILE = join(DATA_DIR, 'foreign-catalog.v1.json')

/** One browsable source that has data on this machine. */
export interface ForeignSource {
  readonly agentId: string
  readonly label: string
  /** Candidate artifacts found by name (a few may turn out not to be conversations). */
  readonly count: number
  readonly newestMtimeMs: number
}

interface StoredEntry {
  readonly fp: Fingerprint
  readonly summary: ForeignSessionSummary | null
}

interface SnapshotFile {
  readonly version: 1
  readonly sources: readonly ForeignSource[]
  readonly agents: Readonly<Record<string, Readonly<Record<string, StoredEntry>>>>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function isFingerprint(value: unknown): value is Fingerprint {
  return isObject(value) && typeof value.mtimeMs === 'number' && typeof value.size === 'number'
}

function isSummary(value: unknown): value is ForeignSessionSummary {
  return isObject(value) && typeof value.agentId === 'string' && typeof value.sessionKey === 'string'
    && typeof value.ref === 'string' && typeof value.title === 'string' && typeof value.cwd === 'string'
    && typeof value.lastMessageAt === 'number' && typeof value.createdAt === 'number'
}

function isSource(value: unknown): value is ForeignSource {
  return isObject(value) && typeof value.agentId === 'string' && typeof value.label === 'string'
    && typeof value.count === 'number' && typeof value.newestMtimeMs === 'number'
}

/** Read the snapshot; anything missing or malformed reads as empty. */
function readSnapshot(file: string): { sources: ForeignSource[], agents: Map<string, Map<string, StoredEntry>> } {
  const empty = { sources: [], agents: new Map<string, Map<string, StoredEntry>>() }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return empty
  }
  if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sources) || !isObject(parsed.agents)) return empty
  const agents = new Map<string, Map<string, StoredEntry>>()
  for (const [agentId, entries] of Object.entries(parsed.agents)) {
    if (!isObject(entries)) continue
    const valid = new Map<string, StoredEntry>()
    for (const [ref, entry] of Object.entries(entries)) {
      if (!isObject(entry) || !isFingerprint(entry.fp)) continue
      if (entry.summary !== null && !isSummary(entry.summary)) continue
      valid.set(ref, { fp: entry.fp, summary: entry.summary })
    }
    agents.set(agentId, valid)
  }
  return { sources: parsed.sources.filter(isSource), agents }
}

const newestFirst = (a: ForeignSessionSummary, b: ForeignSessionSummary): number => b.lastMessageAt - a.lastMessageAt

/** Whether an adapter can be browsed (summary scan + full load). */
export function isBrowsable(adapter: MigrationAdapter): boolean {
  return adapter.walk !== undefined && adapter.scan !== undefined && adapter.load !== undefined
}

export interface RefreshOptions {
  readonly signal?: AbortSignal
  /** Called per conversation as the scan finds it (unordered). */
  readonly onEntry?: (summary: ForeignSessionSummary) => void
}

export class ForeignCatalog {
  private readonly file: string
  private readonly adapters: readonly MigrationAdapter[]
  private loaded = false
  private knownSources: readonly ForeignSource[] = []
  private readonly entries = new Map<string, Map<string, StoredEntry>>()
  private readonly generations = new Map<string, number>()
  private sourcesGeneration = 0
  private writing: Promise<void> = Promise.resolve()

  /**
   * @param adapters - every registered adapter; only browsable ones are used.
   * @param file - snapshot path (tests point it at a scratch directory).
   */
  constructor(adapters: readonly MigrationAdapter[], file: string = FOREIGN_CATALOG_FILE) {
    this.adapters = adapters.filter(isBrowsable)
    this.file = file
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const snapshot = readSnapshot(this.file)
    const browsable = new Set(this.adapters.map(adapter => adapter.id))
    this.knownSources = snapshot.sources.filter(source => browsable.has(source.agentId))
    for (const [agentId, entries] of snapshot.agents) if (browsable.has(agentId)) this.entries.set(agentId, entries)
  }

  /** The adapter behind one browsable source. */
  adapter(agentId: string): MigrationAdapter | undefined {
    return this.adapters.find(adapter => adapter.id === agentId)
  }

  /** Last known sources with data, newest activity first (from the snapshot until refreshed). */
  sources(): readonly ForeignSource[] {
    this.ensureLoaded()
    return this.knownSources
  }

  /** Last known conversations of one source, newest first. */
  sessions(agentId: string): readonly ForeignSessionSummary[] {
    this.ensureLoaded()
    const entries = this.entries.get(agentId)
    if (entries === undefined) return []
    const summaries: ForeignSessionSummary[] = []
    for (const entry of entries.values()) if (entry.summary !== null) summaries.push(entry.summary)
    return summaries.sort(newestFirst)
  }

  /** Count candidates and find the newest activity of every source, by name alone. */
  async refreshSources(signal?: AbortSignal): Promise<readonly ForeignSource[]> {
    this.ensureLoaded()
    const generation = ++this.sourcesGeneration
    const found: ForeignSource[] = []
    for (const adapter of this.adapters) {
      let count = 0
      let newest = 0
      for await (const file of walkFiles(adapter.roots(), { ...adapter.walk!, signal })) {
        const fp = await fingerprintOf(file.path)
        if (fp === undefined) continue
        count += 1
        newest = Math.max(newest, fp.mtimeMs)
      }
      if (count > 0) found.push({ agentId: adapter.id, label: adapter.label, count, newestMtimeMs: newest })
    }
    found.sort((a, b) => b.newestMtimeMs - a.newestMtimeMs)
    if (generation === this.sourcesGeneration) {
      this.knownSources = found
      await this.persist()
    }
    return this.knownSources
  }

  /**
   * Rescan one source, reusing unchanged summaries, and publish the result
   * unless a newer refresh of the same source started meanwhile.
   * @returns The published conversations, newest first.
   */
  async refreshSessions(agentId: string, options: RefreshOptions = {}): Promise<readonly ForeignSessionSummary[]> {
    this.ensureLoaded()
    const adapter = this.adapter(agentId)
    if (adapter === undefined) return []
    const generation = (this.generations.get(agentId) ?? 0) + 1
    this.generations.set(agentId, generation)
    const previous = this.entries.get(agentId) ?? new Map<string, StoredEntry>()
    const scanned = await adapter.scan!({
      signal: options.signal,
      cached: (ref, fp) => {
        const stored = previous.get(ref)
        return stored !== undefined && stored.fp.mtimeMs === fp.mtimeMs && stored.fp.size === fp.size ? stored.summary : undefined
      },
      onEntry: options.onEntry,
    })
    if (this.generations.get(agentId) !== generation) return this.sessions(agentId)
    this.entries.set(agentId, new Map(scanned.map(entry => [entry.ref, { fp: entry.fp, summary: entry.summary }])))
    await this.persist()
    return this.sessions(agentId)
  }

  /** Write the snapshot atomically; writes are serialized, failures leave the old file. */
  private persist(): Promise<void> {
    const snapshot: SnapshotFile = {
      version: 1,
      sources: this.knownSources,
      agents: Object.fromEntries([...this.entries].map(([agentId, entries]) => [agentId, Object.fromEntries(entries)])),
    }
    const text = JSON.stringify(snapshot)
    this.writing = this.writing.then(async () => {
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`
      try {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
        await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, this.file)
      } catch {
        await rm(temporary, { force: true }).catch(() => {})
      }
    })
    return this.writing
  }
}
