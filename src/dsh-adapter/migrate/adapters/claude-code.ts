/**
 * Claude Code adapter: `~/.claude/projects/<munged-cwd>/<session>.jsonl`.
 * File discovery lives here; the line format is parsed by the pure
 * claude-code.parse.ts.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/claude-code
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { MigrationAdapter, MigrationDiscovery, MigrationSession } from '../types.js'
import { parseClaudeTranscript } from './claude-code.parse.js'
import { countEntries } from './scan.js'

/** Sub-agent transcripts (`<session>/subagents/*.jsonl`) belong to their
 *  parent session; they are never conversations of their own. */
const SUBAGENT_DIR = 'subagents'

function readOne(path: string, fallbackCwd: string): MigrationSession | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  // basename(), not split('/'): join() produces `\` separators on Windows, so
  // splitting on '/' would leave the WHOLE absolute path as the id — and the
  // id is the dedupe key (moving the source store would re-import everything).
  return parseClaudeTranscript({ raw, fileStem: basename(path).replace(/\.jsonl$/u, ''), fallbackCwd })
}

export const claudeCodeAdapter: MigrationAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  roots: () => [join(homedir(), '.claude', 'projects')],
  discover(): MigrationDiscovery {
    const roots = this.roots()
    const sessions: MigrationSession[] = []
    const walk = (dir: string, depth: number, fallbackCwd: string): void => {
      if (depth > 3) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== SUBAGENT_DIR) walk(path, depth + 1, unmunge(entry.name) ?? fallbackCwd)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            if (statSync(path).size > 64 * 1024 * 1024) continue
          } catch {
            continue
          }
          const session = readOne(path, fallbackCwd)
          if (session !== undefined) sessions.push(session)
        }
      }
    }
    for (const root of roots) walk(root, 0, homedir())
    return { roots, sessions }
  },
  count(): number {
    return countEntries(this.roots(), { maxDepth: 3, fileMatch: name => name.endsWith('.jsonl'), skipDirs: [SUBAGENT_DIR] })
  },
}

/** Best-effort inverse of Claude Code's dash-munged directory names. */
function unmunge(name: string): string | undefined {
  if (!name.startsWith('-')) return undefined
  return `/${name.split('-').filter(Boolean).join('/')}`
}
