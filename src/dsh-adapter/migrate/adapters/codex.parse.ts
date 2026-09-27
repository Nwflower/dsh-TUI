/**
 * Codex rollout parsing (pure): one `rollout-*.jsonl` → one
 * {@link MigrationSession}.
 *
 * Rows are `{ timestamp, type, payload }` envelopes. `session_meta` and
 * `turn_context` carry metadata (cwd, the model in effect); `response_item`
 * rows are the model-visible history (OpenAI Responses items); `event_msg`
 * rows are UI housekeeping that repeats response items and is skipped.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/codex.parse
 */
import { isRecord, parseJsonl, type JsonRecord } from '../parse/jsonl.js'
import { emptyStats } from '../parse/role-turns.js'
import { newStep } from '../parse/tools.js'
import type { ImportStep, ImportTurn, MigrationSession } from '../types.js'

/** What the adapter knows about a rollout besides its text. */
export interface CodexRolloutInput {
  readonly raw: string
  /** The rollout's stable source id (the uuid in its file name). */
  readonly sourceId: string
}

function toMillis(iso: unknown): number {
  return typeof iso === 'string' ? Date.parse(iso) || 0 : 0
}

/** Text of the blocks of one kind (`input_text` / `output_text`). */
function blocksText(content: unknown, want: string): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === want && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/**
 * Parse one Codex rollout.
 * @returns The session, or undefined when it records no cwd or no prompt.
 */
export function parseCodexRollout(input: CodexRolloutInput): MigrationSession | undefined {
  const { records, badLines } = parseJsonl(input.raw)
  const stats = { ...emptyStats(), badLines }
  let turns: ImportTurn[] = []
  let current: ImportTurn | undefined
  let cwd: string | undefined
  let startedAt = 0
  let model: string | undefined

  const openStep = (): ImportStep => {
    if (current === undefined) {
      current = { prompt: '', steps: [] }
      turns.push(current)
    }
    const step = newStep(model)
    current.steps.push(step)
    return step
  }

  const acceptMessage = (payload: JsonRecord): void => {
    if (payload.role === 'user') {
      const prompt = blocksText(payload.content, 'input_text')
      if (prompt === '') return
      current = { prompt, steps: [] }
      turns.push(current)
    } else if (payload.role === 'assistant') {
      const text = blocksText(payload.content, 'output_text')
      if (text === '') return
      openStep().blocks.push({ type: 'text', text })
    }
  }

  for (const record of records) {
    const payload = record.payload
    if (!isRecord(payload)) continue
    const time = toMillis(record.timestamp)
    if (record.type === 'session_meta') {
      if (typeof payload.cwd === 'string' && payload.cwd !== '') cwd = payload.cwd
      startedAt ||= toMillis(payload.timestamp) || time
      continue
    }
    // Codex records the active model per turn; it applies to the steps after it.
    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model !== '') model = payload.model
      continue
    }
    if (record.type !== 'response_item' || payload.type !== 'message') continue
    startedAt ||= time
    acceptMessage(payload)
  }

  turns = turns.filter(turn => turn.prompt !== '' || turn.steps.length > 0)
  if (cwd === undefined || !turns.some(turn => turn.prompt !== '')) return undefined
  return { sourceId: input.sourceId, cwd, titleExplicit: false, startedAt, turns, stats }
}
