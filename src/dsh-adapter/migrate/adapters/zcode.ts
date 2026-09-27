/**
 * zcode adapter: `~/.zcode/v2/sessions/<dir>/<taskId>.json`, one JSON object
 * per conversation. Discovery lives here; the document is parsed by the pure
 * zcode.parse.ts.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/zcode
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MigrationAdapter, MigrationDiscovery, MigrationSession } from '../types.js'
import { countEntries } from './scan.js'
import { parseZcodeSession } from './zcode.parse.js'

function readOne(path: string): MigrationSession | undefined {
  try {
    return parseZcodeSession(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export const zcodeAdapter: MigrationAdapter = {
  id: 'zcode',
  label: 'zcode',
  roots: () => [join(homedir(), '.zcode', 'v2', 'sessions')],
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile() && entry.name.endsWith('.json')) {
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
    return countEntries(this.roots(), { maxDepth: 3, fileMatch: name => name.endsWith('.json') })
  },
}
