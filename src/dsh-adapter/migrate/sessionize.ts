/**
 * Cross-agent conversation migration: MigrationSession → official DSH events.
 *
 * The sessionize step owns NO storage decisions. It drives the official
 * `Session` logical-event API (`Session.create` + `append`), so envelope
 * fields (seq/time/id), surface contract and format version come from the
 * upstream implementation — the part the first iteration of this feature got
 * wrong by hand-crafting physical log rows. Physical encoding, project
 * layout, zstd and atomic writes belong to JsonlSessionPersistence (see
 * index.ts), exactly as scripts/migrate-sessions-to-jsonl.mts does for the
 * retired sqlite store.
 *
 * Turn shape follows the live loop: `turn/start`, then one step per
 * {@link ImportStep} with the turn's prompt as the first step's user message,
 * then `turn/end`. A turn with no prompt (source lost its head) carries no
 * user message; a turn with no step is a legal step-less turn whose prompt
 * sits directly inside the turn.
 *
 * Inside a step, events follow the live loop too: the step's user inputs
 * (mid-turn context), the assistant message whose content carries the
 * tool-call blocks, one `tool/call` per call, then one `tool/result` per
 * call citing its call event. Parsing already closed every call
 * (closeToolPairs), so no step leaves a call unanswered — the invariant the
 * wire needs on resume: every tool call is followed by its tool message
 * before any later assistant message.
 *
 * System head: the live loop reserves surface node 0 for the system prompt
 * (an empty `system/message` in the first step, before any user message).
 * An imported log gets the same empty head: it projects to no message, so
 * re-reading is unchanged, and when the session is resumed the loop REPLACES
 * it with the rendered prompt. Without it the loop appends its prompt after
 * the imported history, where adapters that only lift a LEADING system
 * message (pi-ai) send it as one more user message.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/sessionize
 */
import {
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ReasoningBlock, TextBlock, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { ImportStep, MigrationSession } from './types.js'

/** One migration turn's model-visible outcome, ready for persistence. */
export interface SessionizedLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

/** Blocks for one migrated step, in source order (reasoning before the text
 *  it explains, tool calls where the model made them). A step with no
 *  content keeps one empty text block so the assistant message stays
 *  well-formed. */
function assistantBlocks(step: ImportStep): (TextBlock | ReasoningBlock | ToolCallBlock)[] {
  const blocks: (TextBlock | ReasoningBlock | ToolCallBlock)[] = step.blocks.map(block =>
    block.type === 'tool-call'
      ? { type: 'tool-call', id: ToolCallId(block.id), name: block.name, arguments: block.arguments }
      : { type: block.type, text: block.text })
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

/**
 * Build one official DSH session log from a normalized foreign conversation.
 *
 * @param id - deterministic session id (see uuid.ts); the id IS the dedupe.
 * @param agentId - source adapter id, stamped into assistant provenance as
 *   `migrated:<agentId>` so the transcript can name where text came from.
 * @param session - the normalized foreign conversation.
 * @returns the official header plus the full event log, exactly as the
 *   persistence backend expects them.
 */
export function sessionize(id: SessionId, agentId: string, session: MigrationSession): SessionizedLog {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: session.startedAt,
    cwd: session.cwd,
    isSeeded: false,
  }
  const model = Session.create(id, undefined, header)
  // Collect each append()'s RETURN (a fully enveloped event) instead of the
  // deprecated snapshotEvents() bulk read — upstream forbids NEW callers of
  // the latter, and append already returns seq/time-stamped events.
  const events: SessionEvent[] = []
  let headWritten = false
  const writeHead = (turn: number, step: number): void => {
    events.push(model.append('system/message', { turn, step, message: createSystemMessage('') }, { surfaceOp: 'append' }))
    headWritten = true
  }
  const writePrompt = (prompt: string): void => {
    if (prompt === '') return
    events.push(model.append('user/message', createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }))
  }
  const writeTools = (turn: number, step: number, imported: ImportStep): void => {
    const callSeqs = new Map<string, SessionSeq>()
    for (const block of imported.blocks) {
      if (block.type !== 'tool-call') continue
      const call = model.append('tool/call', { turn, step, callId: ToolCallId(block.id), name: block.name, arguments: block.arguments })
      events.push(call)
      callSeqs.set(block.id, call.seq)
    }
    for (const result of imported.results) {
      const callSeq = callSeqs.get(result.callId)
      if (callSeq === undefined) continue
      events.push(model.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId: ToolCallId(result.callId),
          content: result.text === '' ? [] : [{ type: 'text', text: result.text }],
          isError: result.isError,
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] }))
    }
  }
  let turnIndex = 0
  for (const turn of session.turns) {
    turnIndex += 1
    events.push(model.append('turn/start', { turn: turnIndex }))
    if (turn.steps.length === 0) {
      if (headWritten) {
        writePrompt(turn.prompt)
      } else {
        // The head needs an open step; a step-less first turn gets one that
        // carries only the head and the prompt (no model call).
        events.push(model.append('step/start', { turn: turnIndex, step: 1 }))
        writeHead(turnIndex, 1)
        writePrompt(turn.prompt)
        events.push(model.append('step/end', { turn: turnIndex, step: 1 }))
      }
    }
    let step = 0
    for (const imported of turn.steps) {
      step += 1
      events.push(model.append('step/start', { turn: turnIndex, step }))
      if (!headWritten) writeHead(turnIndex, step)
      if (step === 1) writePrompt(turn.prompt)
      for (const input of imported.inputs) writePrompt(input)
      events.push(model.append('assistant/message', {
        turn: turnIndex,
        step,
        message: createAssistantMessage({
          content: assistantBlocks(imported),
          // createAssistantMessage stamps `kind: 'model'` itself; the
          // caller-visible provenance is provider + model only.
          source: {
            provider: `migrated:${agentId}`,
            model: imported.model ?? agentId,
          },
        }),
        stream: [],
      }, { surfaceOp: 'append' }))
      writeTools(turnIndex, step, imported)
      events.push(model.append('step/end', { turn: turnIndex, step }))
    }
    // A source-recorded interruption keeps its meaning. Sources record it
    // coarsely (no user/hook/dispose distinction), which is exactly what the
    // `legacy` cancel cause exists for.
    events.push(model.append('turn/end', {
      turn: turnIndex,
      reason: turn.aborted === true ? { kind: 'aborted', reason: { kind: 'legacy' } } : { kind: 'completed' },
    }))
  }
  return { header: model.header, events }
}
