/**
 * Compaction-tail seed spec: {@link buildSidechatInheritance} must reuse the
 * parent's last summarizing compaction instead of copying its whole log.
 *
 * Why this is sound: the compaction checkpoint `user/message` REPLACES the
 * shadowed span on the model-visible surface, so a child seeded with
 * [pre-cut visible nodes + checkpoint + post-compaction tail] folds to the
 * SAME surface as the parent — identical model-visible conversation, same
 * provider context-cache prefix — while dropping the shadowed bulk from the
 * durable copy. The construction is verified with the REAL fold
 * (`foldSurface` from `@deepseek-ai/dsh-session/surface`): when the tail
 * cannot be proven equivalent (dangling back-references, reordering
 * replaces), the builder falls back to today's verbatim full copy.
 */
import { describe, expect, it } from 'vitest'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { buildSidechatInheritance } from '../src/sidechat-core.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

/** Log-only event (no surface marker; folds to nothing visible). */
function lo(type: string, seq: number, data: Record<string, unknown> = {}): SidebarSessionEvent {
  return { type, seq, time: seq * 1000, data } as SidebarSessionEvent
}

/** Surface-eligible event appended the way the live pipeline appends it. */
function sf(type: string, seq: number, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time: seq * 1000, data, surfaceOp: 'append' } as SidebarSessionEvent
}

function userMessage(id: string, text: string): Record<string, unknown> {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    id: `m-${text}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', stream: [] },
  }
}

function toolResultMessage(callId: string, text: string): Record<string, unknown> {
  return {
    id: `m-${callId}`,
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content: [{ type: 'text', text }],
    isError: false,
  }
}

/** One completed turn with an optional tool pair; returns its events plus the
 *  seqs of its surface-visible nodes (user, result, assistant). */
function turn(
  seq: number,
  turnNumber: number,
  over: { text?: string; callId?: string; result?: string } = {},
): { events: SidebarSessionEvent[]; nodes: number[] } {
  const text = over.text ?? `q${turnNumber}`
  const events: SidebarSessionEvent[] = [
    lo('turn/start', seq, { turn: turnNumber }),
    lo('step/start', seq + 1, { turn: turnNumber, step: 1 }),
  ]
  const nodes: number[] = [seq + 2]
  events.push(sf('user/message', seq + 2, userMessage(`m-q${turnNumber}`, text)))
  let next = seq + 3
  if (over.callId !== undefined) {
    events.push(lo('tool/call', next, { turn: turnNumber, step: 1, callId: over.callId, name: 'bash', arguments: '{}' }))
    events.push(sf('tool/result', next + 1, { turn: turnNumber, step: 1, message: toolResultMessage(over.callId, over.result ?? 'ok') }))
    nodes.push(next + 1)
    next += 2
  }
  events.push(sf('assistant/message', next, { turn: turnNumber, step: 1, message: assistantMessage(`a${turnNumber}`), stream: [] }))
  nodes.push(next)
  events.push(lo('step/end', next + 1, { turn: turnNumber, step: 1 }))
  events.push(lo('turn/end', next + 2, { turn: turnNumber, reason: { kind: 'completed' } }))
  return { events, nodes }
}

interface CompactedLog {
  readonly events: SidebarSessionEvent[]
  /** Seqs the checkpoint shadows (the old span's surface nodes). */
  readonly shadowed: number[]
  /** The checkpoint replacement event's seq. */
  readonly checkpoint: number
}

/**
 * The canonical compacted parent: protected system head, one shadowed old
 * turn WITH a tool pair, one keep-window turn WITH its own tool pair, the
 * compaction group, then one post-compaction tail turn.
 */
function compactedLog(): CompactedLog {
  const events: SidebarSessionEvent[] = [
    sf('system/message', 0, { id: 'm-sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system' } }),
  ]
  const old = turn(1, 1, { callId: 'c-old', result: 'old result' })
  events.push(...old.events)
  const keep = turn(1 + old.events.length, 2, { callId: 'c-keep', result: 'keep result' })
  events.push(...keep.events)
  let seq = events.length
  const shadowed = old.nodes
  events.push(lo('compaction/start', seq, { compactionId: 'cp1', turn: null }))
  events.push(lo('compaction/summary', seq + 1, {
    compactionId: 'cp1',
    summary: [{ type: 'text', text: 'turn 1 summarized' }],
    shadowedRange: { start: shadowed[0] ?? 0, end: shadowed[shadowed.length - 1] ?? 0 },
    shadowedSeqs: shadowed,
    shadowedTokenCount: 100,
    provider: 'deepseek',
    model: 'test-model',
    rawOutput: [],
    llmStreamCall: true,
  }))
  const checkpoint = seq + 2
  events.push({
    type: 'user/message',
    seq: checkpoint,
    time: checkpoint * 1000,
    data: {
      id: 'm-cp1',
      role: 'user',
      content: [{ type: 'text', text: 'turn 1 summarized' }],
      source: { kind: 'compact-checkpoint', compactionId: 'cp1' },
    },
    surfaceOp: { op: 'replace', startSeq: shadowed[0] ?? 0, endSeq: shadowed[shadowed.length - 1] ?? 0 },
    sourceEventSeqs: shadowed,
  } as SidebarSessionEvent)
  events.push(lo('compaction/end', seq + 3, { compactionId: 'cp1', turn: null }))
  events.push(...turn(seq + 4, 3, { callId: 'c-tail', result: 'tail result' }).events)
  return { events, shadowed, checkpoint }
}

/** The model-visible sequence a fold produces: one `type:data` token per node. */
function visibleSequence(events: readonly SidebarSessionEvent[]): string[] {
  const fold = foldSurface(events as unknown as readonly SessionEvent[])
  return fold.nodes.map(seq => {
    const event = events[seq]
    return event === undefined ? `missing:${seq}` : `${event.type}:${JSON.stringify(event.data)}`
  })
}

function expectContiguous(seed: readonly { seq: number }[]): void {
  seed.forEach((event, index) => expect(event.seq).toBe(index))
}

describe('buildSidechatInheritance compaction tail', () => {
  it('reuses the last summarizing compaction instead of copying the shadowed span', () => {
    const { events, checkpoint } = compactedLog()
    const { seed, snapshot } = buildSidechatInheritance(events)
    expect(snapshot).toBeNull()
    // The shadowed old turn (its visible nodes AND its log-only scaffolding
    // and tool/call) is dropped entirely.
    expect(seed.length).toBeLessThan(events.length)
    expect(seed.some(event => JSON.stringify(event).includes('old result'))).toBe(false)
    expect(seed.some(event => JSON.stringify(event).includes('c-old'))).toBe(false)
    // The keep window survives — including its paired tool call before its result.
    const keepCall = seed.findIndex(event => JSON.stringify(event).includes('c-keep'))
    const keepResult = seed.findIndex(event => JSON.stringify(event).includes('keep result'))
    expect(keepCall).toBeGreaterThanOrEqual(0)
    expect(keepResult).toBeGreaterThan(keepCall)
    // The checkpoint survives as a plain append (its replace targets are gone).
    const cp = seed.find(event => event.seq !== undefined && JSON.stringify(event).includes('turn 1 summarized'))
    expect(cp).toBeDefined()
    expect((cp as { surfaceOp?: unknown }).surfaceOp).toBe('append')
    expect((cp as { sourceEventSeqs?: unknown }).sourceEventSeqs).toBeUndefined()
    expectContiguous(seed)
    void checkpoint
  })

  it('folds to the same model-visible sequence as the parent (surface equivalence)', () => {
    const { events } = compactedLog()
    const parent = visibleSequence(events)
    expect(parent.length).toBeGreaterThan(0)
    const { seed } = buildSidechatInheritance(events)
    const child = visibleSequence(seed)
    expect(child).toEqual(parent)
  })

  it('falls back to the verbatim full copy when the log has no compaction', () => {
    const { events } = turn(0, 1, { callId: 'c1' })
    const { seed } = buildSidechatInheritance(events)
    expectContiguous(seed)
    expect(seed.map(event => event.type)).toEqual(events.map(event => event.type))
  })

  it('falls back to the verbatim full copy when a tail event references the dropped head', () => {
    const { events } = compactedLog()
    // A developer/message citing a pre-cut request/header: the reference
    // cannot be renumbered, so the tail is not provably equivalent.
    const dangling = sf('developer/message', events.length, {
      id: 'm-dev',
      role: 'developer',
      content: [{ type: 'text', text: 'dev' }],
      source: { kind: 'developer' },
      headerSeq: 1,
    })
    const withDangling = [...events, dangling]
    const { seed } = buildSidechatInheritance(withDangling)
    const full = buildSidechatInheritance(events)
    // Full copy of the SAME log minus the dangling event appended... the
    // fallback copies everything verbatim, so the seed carries the old span.
    expect(seed.some(event => JSON.stringify(event).includes('old result'))).toBe(true)
    void full
  })

  it('keeps the open-turn closers and snapshot semantics on the trimmed tail', () => {
    const { events, checkpoint } = compactedLog()
    // Append an OPEN turn whose tool call has no result yet → dangling →
    // the builder cuts before it and delivers a structured snapshot.
    let seq = events.length
    events.push(lo('turn/start', seq, { turn: 4 }))
    events.push(lo('step/start', seq + 1, { turn: 4, step: 1 }))
    events.push(lo('tool/call', seq + 2, { turn: 4, step: 1, callId: 'c-open', name: 'bash', arguments: '{}' }))
    const { seed, snapshot } = buildSidechatInheritance(events)
    expectContiguous(seed)
    expect(seed.at(-1)?.type).not.toBe('tool/call')
    expect(snapshot).not.toBeNull()
    void checkpoint
  })
})
