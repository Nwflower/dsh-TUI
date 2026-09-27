/**
 * Grok Build session parsing (pure): one session directory's `summary.json`
 * + `chat_history.jsonl` → one {@link MigrationSession}.
 *
 * `summary.json` carries the metadata (`info.id`, `info.cwd`, titles, clock).
 * `chat_history.jsonl` rows are tagged conversation items: `user` rows carry
 * block-array content, `assistant` rows a plain string, and a `reasoning`
 * row precedes the assistant row it explains. Rows carry no per-row
 * timestamp. The legacy v0 shape (`{role, content}`) is accepted alongside.
 *
 * Tool traffic: an assistant row lists its calls in a top-level `tool_calls`
 * array (`{ id, name, arguments }`); each result is a `tool_result` row
 * naming `tool_call_id`, with optional `images` (replaced by placeholders).
 * `backend_tool_call` rows are provider-side tools (web search) the model
 * never called through the harness; they are counted, not imported.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/grok-build.parse
 */
import { isRecord, parseJsonl, type JsonRecord } from '../parse/jsonl.js'
import { emptyStats } from '../parse/role-turns.js'
import { CallIndex, IMAGE_PLACEHOLDER, closeToolPairs, newStep } from '../parse/tools.js'
import type { ImportTurn, MigrationSession } from '../types.js'

/** One session directory's two files, as text. */
export interface GrokSessionInput {
  readonly summaryJson: string
  readonly chatHistory: string
}

function toMillis(iso: unknown): number {
  return typeof iso === 'string' ? Date.parse(iso) || 0 : 0
}

/** Text of string content, or of the text blocks of block-array content. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text !== '') parts.push(part.text)
  }
  return parts.join('\n\n')
}

/** The readable summary of a reasoning row (its encrypted state is never copied). */
function reasoningText(row: JsonRecord): string {
  if (!Array.isArray(row.summary)) return ''
  const parts: string[] = []
  for (const part of row.summary) {
    if (isRecord(part) && typeof part.text === 'string' && part.text !== '') parts.push(part.text)
  }
  return parts.join('\n\n')
}

/**
 * Parse one Grok Build session.
 * @returns The session, or undefined when the summary lacks an id or cwd,
 *   or the history holds no prompt.
 */
export function parseGrokSession(input: GrokSessionInput): MigrationSession | undefined {
  let summaryDoc: unknown
  try {
    summaryDoc = JSON.parse(input.summaryJson)
  } catch {
    return undefined
  }
  if (!isRecord(summaryDoc) || !isRecord(summaryDoc.info)) return undefined
  const { id, cwd } = summaryDoc.info
  if (typeof id !== 'string' || id === '' || typeof cwd !== 'string' || cwd === '') return undefined
  const startedAt = toMillis(summaryDoc.created_at) || toMillis(summaryDoc.updated_at)
  const generatedTitle = summaryDoc.generated_title
  const sessionSummary = summaryDoc.session_summary
  const title = typeof generatedTitle === 'string' && generatedTitle !== ''
    ? generatedTitle
    : typeof sessionSummary === 'string' && sessionSummary !== '' ? sessionSummary : undefined

  const { records, badLines } = parseJsonl(input.chatHistory)
  const stats = { ...emptyStats(), badLines }
  let turns: ImportTurn[] = []
  let current: ImportTurn | undefined
  let pendingReasoning: string[] = []
  const calls = new CallIndex()

  for (const row of records) {
    const kind = row.type === undefined ? row.role : row.type
    if (kind === 'user') {
      // Tagged synthetic injections (system reminders, compaction meta, …)
      // are not the human's words; the default `human` tag is omitted.
      if (row.synthetic_reason !== undefined && row.synthetic_reason !== 'human') continue
      const prompt = blocksText(row.content)
      if (prompt === '') continue
      current = { prompt, steps: [] }
      turns.push(current)
    } else if (kind === 'assistant') {
      const text = blocksText(row.content)
      const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls.filter(isRecord) : []
      if (text === '' && pendingReasoning.length === 0 && toolCalls.length === 0) continue
      if (current === undefined) {
        current = { prompt: '', steps: [] }
        turns.push(current)
      }
      const step = newStep(typeof row.model_id === 'string' && row.model_id !== '' ? row.model_id : undefined)
      // A reasoning row is the pre-sibling of the assistant row it explains.
      for (const reasoning of pendingReasoning) step.blocks.push({ type: 'reasoning', text: reasoning })
      pendingReasoning = []
      if (text !== '') step.blocks.push({ type: 'text', text })
      for (const call of toolCalls) {
        if (typeof call.id !== 'string' || call.id === '') continue
        const name = typeof call.name === 'string' && call.name !== '' ? call.name : 'unknown'
        const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {})
        step.blocks.push({ type: 'tool-call', id: call.id, name, arguments: args })
      }
      calls.register(step)
      current.steps.push(step)
    } else if (kind === 'tool_result') {
      if (typeof row.tool_call_id !== 'string') {
        calls.orphans += 1
        continue
      }
      const images = Array.isArray(row.images) ? row.images.length : 0
      const text = [blocksText(row.content), ...Array.from({ length: images }, () => IMAGE_PLACEHOLDER)].filter(part => part !== '').join('\n')
      calls.attach(row.tool_call_id, text, row.is_error === true)
    } else if (kind === 'backend_tool_call') {
      stats.filtered += 1
    } else if (kind === 'reasoning') {
      const text = reasoningText(row)
      if (text !== '') pendingReasoning.push(text)
    }
  }

  turns = turns.filter(turn => turn.prompt !== '' || turn.steps.length > 0)
  stats.droppedToolResults = calls.orphans + closeToolPairs(turns)
  if (!turns.some(turn => turn.prompt !== '')) return undefined
  return { sourceId: id, cwd, ...(title === undefined ? {} : { title }), titleExplicit: false, startedAt, turns, stats }
}
