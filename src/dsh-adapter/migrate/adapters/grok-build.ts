/**
 * grok-build adapter: `~/.grok/sessions/<encoded-cwd>/<uuid>/` — each session
 * directory holds a `summary.json` and a `chat_history.jsonl`. Discovery and
 * the `GROK_HOME` override live here; both files are parsed by the pure
 * grok-build.parse.ts.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/grok-build
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MigrationAdapter, MigrationDiscovery, MigrationSession } from '../types.js'
import { parseGrokSession } from './grok-build.parse.js'
import { countEntries } from './scan.js'

function readOne(dir: string): MigrationSession | undefined {
  let summaryJson: string
  let chatHistory: string
  try {
    summaryJson = readFileSync(join(dir, 'summary.json'), 'utf8')
    chatHistory = readFileSync(join(dir, 'chat_history.jsonl'), 'utf8')
  } catch {
    return undefined
  }
  return parseGrokSession({ summaryJson, chatHistory })
}

export const grokBuildAdapter: MigrationAdapter = {
  id: 'grok-build',
  label: 'Grok Build',
  roots(): readonly string[] {
    const grokHome = process.env.GROK_HOME?.trim()
    return [join(grokHome !== undefined && grokHome !== '' ? grokHome : join(homedir(), '.grok'), 'sessions')]
  },
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 2) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile() && entry.name === 'chat_history.jsonl') {
          try {
            if (statSync(path).size > 64 * 1024 * 1024) continue
          } catch {
            continue
          }
          const session = readOne(dir)
          if (session !== undefined) sessions.push(session)
        }
      }
    }
    for (const root of roots) walk(root, 0)
    return { roots, sessions }
  },
  count(): number {
    return countEntries(this.roots(), { maxDepth: 2, fileMatch: name => name === 'chat_history.jsonl' })
  },
}
