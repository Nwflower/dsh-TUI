/**
 * Codex adapter: `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl`. File
 * discovery lives here; the rollout format is parsed by the pure
 * codex.parse.ts.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/codex
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { MigrationAdapter, MigrationDiscovery, MigrationSession } from '../types.js'
import { parseCodexRollout } from './codex.parse.js'
import { countEntries } from './scan.js'

function readOne(path: string): MigrationSession | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const match = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(path)
  // Fallback is the bare file name, never the whole path: the id is the dedupe
  // key, so an absolute path would make it depend on where the store lives.
  return parseCodexRollout({ raw, sourceId: match?.[1] ?? basename(path) })
}

export const codexAdapter: MigrationAdapter = {
  id: 'codex',
  label: 'Codex',
  roots: () => [join(homedir(), '.codex', 'sessions')],
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 5) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          try {
            if (statSync(path).size > 64 * 1024 * 1024) continue
          } catch {
            continue
          }
          const session = readOne(path)
          if (session !== undefined) sessions.push(session)
        }
      }
    }
    for (const root of roots) walk(root, 0)
    return { roots, sessions }
  },
  count(): number {
    return countEntries(this.roots(), { maxDepth: 5, fileMatch: name => name.startsWith('rollout-') && name.endsWith('.jsonl') })
  },
}
