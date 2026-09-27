/**
 * Claude Code transcript parsing (pure): one `<session>.jsonl` → one
 * {@link MigrationSession}.
 *
 * Lines are self-describing (`type`). A human prompt is a `user` line whose
 * content is a string or text blocks; an assistant line carries ONE content
 * block of a model response, and one response spans several lines sharing
 * `message.id` (thinking, text, each tool_use — tool results can land
 * between them). Those lines are merged back into one step: one step is one
 * model call.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/claude-code.parse
 */
import { isRecord, parseJsonl, type JsonRecord } from '../parse/jsonl.js'
import { stripSystemReminders } from '../parse/injection.js'
import { emptyStats } from '../parse/role-turns.js'
import { newStep } from '../parse/tools.js'
import type { ImportStep, ImportTurn, MigrationSession } from '../types.js'

/** What the adapter knows about a transcript besides its text. */
export interface ClaudeTranscriptInput {
  readonly raw: string
  /** File name without `.jsonl` — the session's stable source id. */
  readonly fileStem: string
  /** cwd derived from the project directory name, used when no line records one. */
  readonly fallbackCwd: string
}

function toMillis(iso: unknown): number {
  return typeof iso === 'string' ? Date.parse(iso) || 0 : 0
}

/** Text of a string or block-array content (text blocks only). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/** Whether a user line is a tool-result carrier rather than a prompt. */
function isToolResultLine(content: unknown): boolean {
  return Array.isArray(content) && content.some(block => isRecord(block) && block.type === 'tool_result')
}

/**
 * Parse one Claude Code transcript.
 * @returns The session, or undefined when it holds no human prompt.
 */
export function parseClaudeTranscript(input: ClaudeTranscriptInput): MigrationSession | undefined {
  const { records, badLines } = parseJsonl(input.raw)
  const stats = { ...emptyStats(), badLines }
  let turns: ImportTurn[] = []
  let current: ImportTurn | undefined
  /** message.id → its step, within the current turn. */
  let stepOfMessage = new Map<string, ImportStep>()
  let startedAt = 0
  let lineCwd: string | undefined

  const openTurn = (prompt: string): void => {
    current = { prompt, steps: [] }
    turns.push(current)
    stepOfMessage = new Map()
  }

  const appendAssistant = (message: JsonRecord): void => {
    if (current === undefined) openTurn('')
    const turn = current!
    const messageId = typeof message.id === 'string' && message.id !== '' ? message.id : undefined
    let step = messageId === undefined ? undefined : stepOfMessage.get(messageId)
    if (step === undefined) {
      step = newStep(typeof message.model === 'string' && message.model !== '' ? message.model : undefined)
      turn.steps.push(step)
      if (messageId !== undefined) stepOfMessage.set(messageId, step)
    }
    const content = message.content
    if (typeof content === 'string') {
      if (content !== '') step.blocks.push({ type: 'text', text: content })
      return
    }
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        step.blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        // The trace lives in `thinking` (not `text`); accept both.
        const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : ''
        if (text !== '') step.blocks.push({ type: 'reasoning', text })
      }
    }
  }

  for (const record of records) {
    const type = record.type
    if (type !== 'user' && type !== 'assistant') continue
    if (record.isSidechain === true || record.isMeta === true) continue
    const message = record.message
    if (!isRecord(message)) continue
    // Claude Code writes the authoritative cwd on every message line; the
    // dash-munged directory name cannot preserve `_`/`.`/`-`.
    if (typeof record.cwd === 'string' && record.cwd !== '') lineCwd = record.cwd
    if (startedAt === 0) startedAt = toMillis(record.timestamp)
    if (type === 'user') {
      if (isToolResultLine(message.content)) continue
      const prompt = stripSystemReminders(textOf(message.content))
      if (prompt === '') continue
      openTurn(prompt)
      continue
    }
    appendAssistant(message)
  }

  // A response that produced nothing importable leaves no step behind.
  for (const turn of turns) turn.steps = turn.steps.filter(step => step.blocks.length > 0)
  turns = turns.filter(turn => turn.prompt !== '' || turn.steps.length > 0)
  if (!turns.some(turn => turn.prompt !== '')) return undefined

  // cwd precedence: the per-line `cwd` field → the first prompt's
  // "Primary working directory:" note → the unmunged directory name.
  let cwd = lineCwd ?? input.fallbackCwd
  if (lineCwd === undefined) {
    const noted = turns.find(turn => turn.prompt.includes('Primary working directory:'))
    const match = noted === undefined ? null : /Primary working directory: (\S+)/u.exec(noted.prompt)
    if (match !== null) cwd = match[1]!
  }
  return { sourceId: input.fileStem, cwd, titleExplicit: false, startedAt, turns, stats }
}
