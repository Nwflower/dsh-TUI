/**
 * Import ONE foreign conversation through the host's persistence service —
 * the session screen's "select to start" path (the CLI batch keeps
 * importSessions, which mounts its own backend).
 *
 * Order is chosen so a failure never leaves a half-written log that the
 * next click would take for "already imported":
 *   1. the deterministic id already exists → open it, nothing is written;
 *   2. the working directory must exist (resuming into a missing cwd fails
 *      later and less clearly);
 *   3. the whole conversation is parsed and sessionized in memory;
 *   4. only then create → append → flush → close; a write failure removes
 *      what was written, best effort.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/import-one
 */
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { existsSync } from 'node:fs'
import { deleteSessionLog } from '../compat/index.js'
import { sessionize } from './sessionize.js'
import type { LoadSkip, MigrationAdapter, MigrationSession } from './types.js'
import { migrationUuid } from './uuid.js'

/** Structural slice of the persistence service a single import needs. */
export interface ImportPersistence {
  create(header: SessionHeader): Promise<ImportWriteHandle>
  /** Present on current backends: one session's snapshot, undefined when absent. */
  stat?(id: SessionId): Promise<unknown>
  list(): Promise<readonly { header: { id: string } }[]>
}
export interface ImportWriteHandle {
  append(events: readonly SessionEvent[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

/** Outcome of one import request. */
export type ForeignImportResult =
  | { readonly kind: 'ready', readonly sessionId: string, readonly created: boolean }
  | { readonly kind: 'cwd-missing', readonly cwd: string }
  | { readonly kind: 'failed', readonly reason: LoadSkip['skip'] | 'write-failed', readonly detail?: string }

/** Deterministic DSH session id of one foreign conversation (same as /migrate). */
export function foreignSessionId(agentId: string, sourceId: string): SessionId {
  return SessionId(migrationUuid(`${agentId}:${sourceId}`))
}

/**
 * Write one sessionized conversation. Shared by the CLI batch and the
 * single import so both produce byte-identical logs.
 */
export async function writeImportedSession(
  persistence: Pick<ImportPersistence, 'create'>,
  id: SessionId,
  agentId: string,
  session: MigrationSession,
): Promise<void> {
  const { header, events } = sessionize(id, agentId, session)
  const handle = await persistence.create(header)
  try {
    await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
}

async function exists(persistence: ImportPersistence, id: SessionId): Promise<boolean> {
  if (persistence.stat !== undefined) return (await persistence.stat(id)) !== undefined
  return (await persistence.list()).some(entry => entry.header.id === id)
}

export interface ImportRequest {
  /** The listed conversation's stable source id (ForeignSessionSummary.sessionKey). */
  readonly sessionKey: string
  readonly ref: string
  /** The listed cwd; '' when the summary did not know it. */
  readonly cwd: string
}

export interface ImportDeps {
  readonly cwdExists?: (path: string) => boolean
  /** Best-effort removal of a partially written log. */
  readonly discard?: (sessionId: string) => void
}

/**
 * Import one conversation unless it is already present.
 * @returns ready (with whether it was written now), cwd-missing, or failed.
 */
export async function importForeignSession(
  persistence: ImportPersistence,
  adapter: MigrationAdapter,
  request: ImportRequest,
  deps: ImportDeps = {},
): Promise<ForeignImportResult> {
  const cwdExists = deps.cwdExists ?? existsSync
  let id = foreignSessionId(adapter.id, request.sessionKey)
  if (await exists(persistence, id)) return { kind: 'ready', sessionId: id, created: false }
  if (request.cwd !== '' && !cwdExists(request.cwd)) return { kind: 'cwd-missing', cwd: request.cwd }
  if (adapter.load === undefined) return { kind: 'failed', reason: 'not-a-session' }
  const loaded = await adapter.load(request.ref)
  if ('skip' in loaded) return { kind: 'failed', reason: loaded.skip }
  if (!cwdExists(loaded.cwd)) return { kind: 'cwd-missing', cwd: loaded.cwd }
  // The artifact may have changed identity since it was listed; the id always
  // follows what is actually imported, exactly as /migrate derives it.
  if (loaded.sourceId !== request.sessionKey) {
    id = foreignSessionId(adapter.id, loaded.sourceId)
    if (await exists(persistence, id)) return { kind: 'ready', sessionId: id, created: false }
  }
  try {
    await writeImportedSession(persistence, id, adapter.id, loaded)
  } catch (error) {
    ;(deps.discard ?? deleteSessionLog)(id)
    return { kind: 'failed', reason: 'write-failed', detail: error instanceof Error ? error.message : String(error) }
  }
  return { kind: 'ready', sessionId: id, created: true }
}

/**
 * One importer per host: a second request for a ref already being imported
 * joins the running one instead of starting another write.
 */
export function createForeignImporter(persistence: () => ImportPersistence | undefined, deps: ImportDeps = {}) {
  const inFlight = new Map<string, Promise<ForeignImportResult>>()
  return {
    isImporting: (agentId: string, ref: string): boolean => inFlight.has(`${agentId}|${ref}`),
    import(adapter: MigrationAdapter, request: ImportRequest): Promise<ForeignImportResult> {
      const key = `${adapter.id}|${request.ref}`
      const running = inFlight.get(key)
      if (running !== undefined) return running
      const service = persistence()
      if (service === undefined) return Promise.resolve({ kind: 'failed', reason: 'write-failed', detail: 'session persistence unavailable' })
      const started = importForeignSession(service, adapter, request, deps)
        .catch((error: unknown): ForeignImportResult => ({ kind: 'failed', reason: 'write-failed', detail: error instanceof Error ? error.message : String(error) }))
        .finally(() => inFlight.delete(key))
      inFlight.set(key, started)
      return started
    },
  }
}
