/**
 * Foreign-session facade: the session screen's source tabs browse other
 * coding agents' conversations and import one on selection.
 *
 * The catalog (migrate/catalog.ts) is created on first use, so a session
 * that never opens a source tab never reads the snapshot. Imports go through
 * the host's own `sessionPersistence` — same root, same backend, one writer
 * — so the imported session is immediately visible to resume.
 *
 * @module @deepseek-harness-tui/dsh-tui/dsh-adapter/channel/foreign-sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ForeignImportOutcome, ForeignSessionRow, ForeignSource } from '../../adapter/ports/channel-session.js'
import { ForeignCatalog } from '../migrate/catalog.js'
import { createForeignImporter, type ImportPersistence } from '../migrate/import-one.js'
import { MIGRATION_ADAPTERS } from '../migrate/index.js'
import type { ChannelOwner } from './owner.js'

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

export function createForeignSessionActions(ctx: Context, deps: { owner: Pick<ChannelOwner, 'signal'> }) {
  let catalog: ForeignCatalog | undefined
  const catalogOf = (): ForeignCatalog => (catalog ??= new ForeignCatalog(MIGRATION_ADAPTERS))
  const importer = createForeignImporter(() => ctx.get('sessionPersistence') as ImportPersistence | undefined)

  return {
    foreignSources: (): readonly ForeignSource[] => catalogOf().sources(),
    async refreshForeignSources(): Promise<readonly ForeignSource[]> {
      try {
        return await catalogOf().refreshSources(deps.owner.signal)
      } catch (error) {
        // Channel teardown mid-walk: the last known answer stands.
        if (isAbort(error)) return catalogOf().sources()
        throw error
      }
    },
    foreignSessions: (agentId: string): readonly ForeignSessionRow[] => catalogOf().sessions(agentId),
    async refreshForeignSessions(agentId: string, onEntry?: (row: ForeignSessionRow) => void): Promise<readonly ForeignSessionRow[]> {
      try {
        return await catalogOf().refreshSessions(agentId, { signal: deps.owner.signal, onEntry })
      } catch (error) {
        if (isAbort(error)) return catalogOf().sessions(agentId)
        throw error
      }
    },
    importForeignSession(agentId: string, ref: string): Promise<ForeignImportOutcome> {
      const adapter = catalogOf().adapter(agentId)
      if (adapter === undefined) return Promise.resolve({ kind: 'failed', reason: 'unknown-source' })
      // A ref the catalog no longer lists still imports: with no known key the
      // existence check misses, and the id is derived from what is loaded.
      const row = catalogOf().sessions(agentId).find(session => session.ref === ref)
      return importer.import(adapter, { sessionKey: row?.sessionKey ?? '', ref, cwd: row?.cwd ?? '' })
    },
  }
}
