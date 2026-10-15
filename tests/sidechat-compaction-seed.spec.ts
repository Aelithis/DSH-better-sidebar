/**
 * Compaction-tail seed spec: {@link buildSidechatInheritance} must reuse the
 * parent's last summarizing compaction instead of copying its whole log.
 *
 * Why this is sound: the compaction checkpoint `user/message` REPLACES the
 * shadowed span on the model-visible surface, so a child seeded with
 * [surviving head skeleton + checkpoint + keep-window + tail verbatim]
 * folds to the SAME surface as the parent — identical model-visible
 * conversation, same provider context-cache prefix — while the shadowed
 * bulk never lands in the durable copy. The construction is verified with
 * the REAL fold (`foldSurface` from `@deepseek-ai/dsh-session/surface`) and
 * pinned against the REAL session relational invariants
 * (`@deepseek-ai/dsh-session/invariant`): when the tail cannot be proven
 * equivalent, the builder falls back to today's verbatim full copy.
 */
import { describe, expect, it } from 'vitest'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import { Session, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
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

function assistantMessage(text: string, over: { callId?: string } = {}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
  if (over.callId !== undefined) {
    content.unshift({ type: 'tool-call', callId: over.callId, name: 'bash', arguments: {} })
  }
  return {
    id: `m-${text}`,
    role: 'assistant',
    content,
    source: { kind: 'model', provider: 'test', model: 'model-x' },
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

/** One completed turn with an optional tool pair; returns its events plus
 *  the seqs of its surface-visible nodes (user, result, assistant). */
function turn(
  seq: number,
  turnNumber: number,
  over: { text?: string; callId?: string; result?: string; assistantCall?: string } = {},
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
  events.push(sf('assistant/message', next, {
    turn: turnNumber,
    step: 1,
    message: assistantMessage(`a${turnNumber}`, over.assistantCall !== undefined ? { callId: over.assistantCall } : {}),
    stream: [],
  }))
  nodes.push(next)
  events.push(lo('step/end', next + 1, { turn: turnNumber, step: 1 }))
  events.push(lo('turn/end', next + 2, { turn: turnNumber, reason: { kind: 'completed' } }))
  return { events, nodes }
}

/** The compaction group appended at `at`: start + summary + checkpoint +
 *  end, shadowing `shadowed` (the span's surface-node seqs). `turn: null`
 *  is the manual between-turns form; a number is the automatic mid-turn
 *  form, and the checkpoint adjacency is the shadow-price contract. */
function compactionGroup(
  at: number,
  shadowed: readonly number[],
  over: { id?: string; turn?: number | null; summary?: string } = {},
): SidebarSessionEvent[] {
  const id = over.id ?? 'cp1'
  const first = shadowed[0] ?? 0
  const last = shadowed[shadowed.length - 1] ?? 0
  const summaryText = over.summary ?? 'old turns summarized'
  const turnValue = over.turn === undefined ? null : over.turn
  return [
    lo('compaction/start', at, { compactionId: id, turn: turnValue }),
    lo('compaction/summary', at + 1, {
      compactionId: id,
      summary: [{ type: 'text', text: summaryText }],
      shadowedRange: { start: first, end: last },
      shadowedSeqs: [...shadowed],
      shadowedTokenCount: 100,
      provider: 'deepseek',
      model: 'test-model',
      rawOutput: [],
      llmStreamCall: true,
    }),
    {
      type: 'user/message',
      seq: at + 2,
      time: (at + 2) * 1000,
      data: {
        id: `m-${id}`,
        role: 'user',
        content: [{ type: 'text', text: summaryText }],
        source: { kind: 'compact-checkpoint', compactionId: id },
      },
      surfaceOp: { op: 'replace', startSeq: first, endSeq: last },
      sourceEventSeqs: [...shadowed],
    } as SidebarSessionEvent,
    lo('compaction/end', at + 3, { compactionId: id, turn: turnValue }),
  ]
}

/**
 * Turn 1's opening, host-shaped: the protected `system/message` (carrying
 * its turn/step) is the first request's first message, and the shadowable
 * old span continues in the SAME step — `oldTurn` supplies the rest.
 */
function systemHead(): SidebarSessionEvent[] {
  return [
    lo('turn/start', 0, { turn: 1 }),
    lo('step/start', 1, { turn: 1, step: 1 }),
    sf('system/message', 2, {
      turn: 1,
      step: 1,
      message: { id: 'm-sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } },
    }),
  ]
}

/** The old span continuing turn 1's step: a tool pair + assistant, closed. */
function oldSpan(): { events: SidebarSessionEvent[]; nodes: number[] } {
  const events: SidebarSessionEvent[] = [
    sf('user/message', 3, userMessage('m-q1', 'q1')),
    lo('tool/call', 4, { turn: 1, step: 1, callId: 'c-old', name: 'bash', arguments: '{}' }),
    sf('tool/result', 5, { turn: 1, step: 1, message: toolResultMessage('c-old', 'old result') }),
    sf('assistant/message', 6, { turn: 1, step: 1, message: assistantMessage('a1'), stream: [] }),
    lo('step/end', 7, { turn: 1, step: 1 }),
    lo('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
  ]
  return { events, nodes: [3, 5, 6] }
}

/**
 * The canonical compacted parent, host-shaped: turn 1 carries the protected
 * system head, turn 2 is the shadowed old span (with a tool pair), turn 3
 * is the keep window with its own tool pair, then the manual compaction
 * group, then one closed tail turn.
 */
function compactedLog(): SidebarSessionEvent[] {
  const events = [...systemHead(), ...oldSpan().events]
  // A whole shadowed turn between the head and the keep window: the seed's
  // turn numbers must be renumbered to run 1, 2, 3… over the gap.
  const shadowTurn = turn(9, 2, { callId: 'c-shadow', result: 'shadow result' })
  events.push(...shadowTurn.events)
  // The keep window is appended BEFORE the compaction group (the group
  // lands at the log's end at compaction time); the tail follows it.
  const keep = turn(17, 3, { callId: 'c-keep', result: 'keep result' })
  events.push(...keep.events)
  // The region shadows the old span's and the middle turn's nodes but NOT
  // the protected head.
  events.push(...compactionGroup(events.length, [3, 5, 6, 11, 13, 14]))
  events.push(...turn(events.length, 4, { callId: 'c-tail', result: 'tail result' }).events)
  return events
}

/**
 * The mid-span shape: the region ends INSIDE the keep window's first turn
 * (the host's boundary is only tool-pairing balanced, not turn aligned), so
 * that turn's early nodes are shadowed while its later ones survive — the
 * keep interval must skip the shadowed surface events and the orphaned
 * tool/call instead of re-emitting them.
 */
function midSpanLog(): SidebarSessionEvent[] {
  const events = [...systemHead(), ...oldSpan().events]
  // Turn 2's first step is shadowed (user + tool pair); its second step's
  // assistant survives — the region ends inside the keep window's first
  // turn, which precedes the compaction group like every keep window does.
  events.push(
    lo('turn/start', 9, { turn: 2 }),
    lo('step/start', 10, { turn: 2, step: 1 }),
    sf('user/message', 11, userMessage('m-q2', 'q2 mid')),
    lo('tool/call', 12, { turn: 2, step: 1, callId: 'c-mid', name: 'bash', arguments: '{}' }),
    sf('tool/result', 13, { turn: 2, step: 1, message: toolResultMessage('c-mid', 'mid result') }),
    lo('step/end', 14, { turn: 2, step: 1 }),
    lo('step/start', 15, { turn: 2, step: 2 }),
    sf('assistant/message', 16, { turn: 2, step: 2, message: assistantMessage('a2 kept'), stream: [] }),
    lo('step/end', 17, { turn: 2, step: 2 }),
    lo('turn/end', 18, { turn: 2, reason: { kind: 'completed' } }),
  )
  events.push(...compactionGroup(19, [3, 5, 6, 11, 13]))
  events.push(...turn(23, 3, { callId: 'c-tail', result: 'tail result' }).events)
  return events
}

/**
 * The automatic-compaction shape: the group fires INSIDE a still-open turn
 * (that turn's skeleton and first message sit BEFORE the cut), and the log
 * ends inside that turn — `kind` picks how: a plain pending assistant
 * message (synthetic closers) or a dangling tool call (structured
 * snapshot).
 */
function midTurnLog(kind: 'closers' | 'dangling'): SidebarSessionEvent[] {
  const events = [...systemHead(), ...oldSpan().events]
  const shadowTurn = turn(9, 2, { callId: 'c-shadow', result: 'shadow result' })
  events.push(...shadowTurn.events)
  const seq = events.length
  events.push(
    lo('turn/start', seq, { turn: 3 }),
    lo('step/start', seq + 1, { turn: 3, step: 1 }),
    sf('user/message', seq + 2, userMessage('m-q3', 'q3')),
  )
  events.push(...compactionGroup(seq + 3, [3, 5, 6, 11, 13, 14], { id: 'cp-auto', turn: 3, summary: 'auto summarized' }))
  const tail = events.length
  if (kind === 'closers') {
    events.push(sf('assistant/message', tail, { turn: 3, step: 1, message: assistantMessage('open answer'), stream: [] }))
  } else {
    events.push(
      sf('assistant/message', tail, { turn: 3, step: 1, message: assistantMessage('with tool', { callId: 'c-open' }), stream: [] }),
      lo('tool/call', tail + 1, { turn: 3, step: 1, callId: 'c-open', name: 'bash', arguments: '{}' }),
    )
  }
  return events
}

/** The model-visible sequence a fold produces, mirroring the renderer's
 *  projection exactly like the builder's own comparison: a user/message IS
 *  its whole data object; every other surface event projects `data.message`. */
function visibleSequence(events: readonly SidebarSessionEvent[]): string[] {
  const fold = foldSurface(events as unknown as readonly SessionEvent[])
  return fold.nodes.map(seq => {
    const event = events[seq]
    if (event === undefined) return `missing:${seq}`
    if (event.type === 'user/message') return `${event.type}:${JSON.stringify(event.data)}`
    return `${event.type}:${JSON.stringify((event.data as { message?: unknown }).message ?? null)}`
  })
}

function expectContiguous(seed: readonly { seq: number }[]): void {
  seed.forEach((event, index) => expect(event.seq).toBe(index))
}

/** Run the REAL session relational invariants over one candidate log and
 *  return the failure messages (empty = the log satisfies them). */
function invariantFailures(log: readonly SidebarSessionEvent[]): string[] {
  const failures: string[] = []
  const session = { snapshotEvents: () => log }
  const ctx = {
    sessions: { list: () => [session] },
    on: () => {},
    invariants: {
      register: (_pkg: string, installer: (c: unknown, f: (m: string) => void) => void) => {
        installer(ctx, (message: string) => { failures.push(message) })
        return () => {}
      },
    },
  }
  void SessionInvariant.apply(ctx as never)
  return failures
}

describe('buildSidechatInheritance compaction tail', () => {
  it('reuses the last summarizing compaction instead of copying the shadowed span', () => {
    const events = compactedLog()
    const { seed, snapshot } = buildSidechatInheritance(events)
    expect(snapshot).toBeNull()
    // The shadowed old turn is dropped entirely — its visible nodes AND its
    // log-only scaffolding and tool/call — while the protected head keeps
    // its turn/step skeleton (closed, because the closers were dropped too).
    expect(seed.length).toBeLessThan(events.length)
    expect(seed.some(event => JSON.stringify(event).includes('old result'))).toBe(false)
    expect(seed.some(event => JSON.stringify(event).includes('c-old'))).toBe(false)
    expect(seed.some(event => JSON.stringify(event).includes('shadow result'))).toBe(false)
    expect(seed.some(event => JSON.stringify(event).includes('c-shadow'))).toBe(false)
    expect(seed.map(event => event.type).slice(0, 5)).toEqual([
      'turn/start', 'step/start', 'system/message', 'step/end', 'turn/end',
    ])
    // The keep window survives VERBATIM: its own tool call stays right
    // before its result.
    const keepCall = seed.findIndex(event => JSON.stringify(event).includes('c-keep'))
    const keepResult = seed.findIndex(event => JSON.stringify(event).includes('keep result'))
    expect(keepCall).toBeGreaterThanOrEqual(0)
    expect(keepResult).toBeGreaterThan(keepCall)
    // The checkpoint survives as a plain append (its replace targets are gone).
    const cp = seed.find(event => JSON.stringify(event).includes('old turns summarized'))
    expect(cp).toBeDefined()
    expect((cp as { surfaceOp?: unknown }).surfaceOp).toBe('append')
    expect((cp as { sourceEventSeqs?: unknown }).sourceEventSeqs).toBeUndefined()
    expectContiguous(seed)
  })

  it('folds to the same model-visible sequence as the parent (surface equivalence)', () => {
    const events = compactedLog()
    const parent = visibleSequence(events)
    expect(parent.length).toBeGreaterThan(0)
    const { seed } = buildSidechatInheritance(events)
    const child = visibleSequence(seed)
    expect(child).toEqual(parent)
  })

  it('satisfies the real session relational invariants', () => {
    const events = compactedLog()
    const { seed } = buildSidechatInheritance(events)
    expect(seed.length).toBeLessThan(events.length)
    expect(invariantFailures(events)).toEqual([])
    expect(invariantFailures(seed)).toEqual([])
    expect(invariantFailures(buildSidechatInheritance(turn(0, 1, { callId: 'c1' }).events).seed)).toEqual([])
  })

  it('is accepted by the real dsh-session seed validator', () => {
    const events = compactedLog()
    const { seed } = buildSidechatInheritance(events)
    // The REAL validator, exactly as the routes call it (isSeeded + the
    // inherited cut) — this is the layer that once rejected a seed whose
    // surfaceOp markers were stripped, so it gates every envelope decision
    // the rebasing makes.
    const id = 'session-compaction-seed-acceptance'
    const session = Session.create(
      id as SessionId,
      seed as never,
      { version: SESSION_FORMAT_VERSION, id: id as SessionId, createdAt: Date.now(), isSeeded: true },
      SessionLogOffset(seed.length),
    )
    // The constructor appends the inherited-cut marker right after the seed,
    // and that marker is the child's first own event (log position = the
    // inherited count) — same shape as today's full-copy threads.
    expect(session.snapshotEvents()).toHaveLength(seed.length + 1)
    expect(session.ownEvents()).toHaveLength(1)
    expect(session.ownEvents()[0]?.type).toBe('session/end-seed')
  })

  it('falls back to the verbatim full copy when the log has no compaction', () => {
    const events = turn(0, 1, { callId: 'c1' }).events
    const { seed } = buildSidechatInheritance(events)
    expectContiguous(seed)
    expect(seed.map(event => event.type)).toEqual(events.map(event => event.type))
  })

  it('falls back to the verbatim full copy when a tail event references the dropped span', () => {
    const events = compactedLog()
    // A developer/message citing a pre-cut request/header: the reference
    // cannot be renumbered, so the tail is not provably equivalent. The
    // fallback must equal TODAY's behavior on this very log: the verbatim
    // copy, event for event.
    const withDangling = [...events, sf('developer/message', events.length, {
      id: 'm-dev',
      role: 'developer',
      content: [{ type: 'text', text: 'dev' }],
      source: { kind: 'developer' },
      headerSeq: 1,
    })]
    const { seed, snapshot } = buildSidechatInheritance(withDangling)
    expect(snapshot).toBeNull()
    // Event-for-event deep equality with the verbatim copy (envelope fields
    // plus the shared data objects), not just a type sequence.
    expect(seed.map(event => [event.type, event.seq, event.time, event.data])).toEqual(
      withDangling.map(event => [event.type, event.seq, event.time, event.data]),
    )
  })

  it('falls back to the verbatim full copy when a tail replace reorders surviving nodes', () => {
    const events = compactedLog()
    // A replacement whose range covers a SURVIVING pre-cut node: the parent
    // fold removes that node and repositions the replacement at its slot,
    // which dropping the span cannot reproduce.
    const keepUserSeq = events.findIndex(event => JSON.stringify(event).includes('m-q2'))
    const replacementSeq = events.length
    events.push({
      type: 'user/message',
      seq: replacementSeq,
      time: replacementSeq * 1000,
      data: userMessage('m-resurfaced', 'resurfaced edit'),
      surfaceOp: { op: 'replace', startSeq: keepUserSeq, endSeq: keepUserSeq },
      sourceEventSeqs: [keepUserSeq],
    } as SidebarSessionEvent)
    const { seed, snapshot } = buildSidechatInheritance(events)
    expect(snapshot).toBeNull()
    expect(seed.map(event => [event.type, event.seq, event.time, event.data])).toEqual(
      events.map(event => [event.type, event.seq, event.time, event.data]),
    )
  })

  it('keeps the open-turn closers on the trimmed tail (mid-turn compaction)', () => {
    const events = midTurnLog('closers')
    // Automatic compaction ran inside the still-open turn; the fork happens
    // mid-turn with a plain pending assistant message. The trim must fire
    // AND the synthetic interrupted-closers must land — the open turn's
    // skeleton is kept verbatim, so the open-turn detection still sees it.
    const { seed, snapshot } = buildSidechatInheritance(events)
    expect(snapshot).toBeNull()
    expect(seed.length).toBeLessThan(events.length)
    expectContiguous(seed)
    expect(seed.at(-2)?.type).toBe('step/end')
    expect(seed.at(-1)?.type).toBe('turn/end')
    expect((seed.at(-1) as { data?: { reason?: { kind?: string } } }).data?.reason?.kind).toBe('interrupted')
    expect(invariantFailures(seed)).toEqual([])
  })

  it('delivers the dangling-tool snapshot on the trimmed tail (mid-turn compaction)', () => {
    const events = midTurnLog('dangling')
    // Same shape but the open turn ends on a tool call with no result yet:
    // providers reject dangling assistant calls, so the builder must cut
    // before the open turn and deliver the structured snapshot — exactly as
    // the full-copy path does.
    const { seed, snapshot } = buildSidechatInheritance(events)
    expect(seed.length).toBeLessThan(events.length)
    expectContiguous(seed)
    expect(seed.at(-1)?.type).not.toBe('tool/call')
    expect(snapshot).not.toBeNull()
    expect(JSON.stringify(snapshot)).toContain('bash')
  })

  it('skips shadowed nodes and orphaned calls when the region ends mid-turn', () => {
    const events = midSpanLog()
    const { seed, snapshot } = buildSidechatInheritance(events)
    // The region ended inside turn 2: its early user+tool pair are shadowed,
    // the later assistant survives. The trim must fire, the keep interval
    // must NOT re-emit the shadowed events (nor the orphaned tool/call),
    // and the skeleton of the partially-shadowed turn stays complete.
    expect(snapshot).toBeNull()
    expect(seed.length).toBeLessThan(events.length)
    expect(seed.some(event => JSON.stringify(event).includes('q2 mid'))).toBe(false)
    expect(seed.some(event => JSON.stringify(event).includes('c-mid'))).toBe(false)
    expect(seed.some(event => JSON.stringify(event).includes('mid result'))).toBe(false)
    expect(seed.some(event => JSON.stringify(event).includes('a2 kept'))).toBe(true)
    expect(visibleSequence(seed)).toEqual(visibleSequence(events))
    expectContiguous(seed)
    expect(invariantFailures(seed)).toEqual([])
  })

  it('remaps replace operations that stay inside the tail', () => {
    const events = compactedLog()
    // One more closed tail turn, then a replacement user/message whose
    // replace range covers ONLY that turn's tail nodes: the range rebases
    // intact, the fold still shows the same transitions, the trim fires.
    const tailTurn = turn(events.length, 5)
    const replacedSeqs = tailTurn.nodes
    events.push(...tailTurn.events)
    const replacementSeq = events.length
    events.push({
      type: 'user/message',
      seq: replacementSeq,
      time: replacementSeq * 1000,
      data: userMessage('m-edited', 'edited tail question'),
      surfaceOp: { op: 'replace', startSeq: replacedSeqs[0] ?? 0, endSeq: replacedSeqs[replacedSeqs.length - 1] ?? 0 },
      sourceEventSeqs: replacedSeqs,
    } as SidebarSessionEvent)
    const parent = visibleSequence(events)
    const { seed } = buildSidechatInheritance(events)
    // The trim must still fire here (the replace reorders only tail nodes —
    // no fallback), which is what makes the remap assertions meaningful.
    expect(seed.length).toBeLessThan(events.length)
    expect(visibleSequence(seed)).toEqual(parent)
    const rebased = seed.find(event => {
      const op = (event as { surfaceOp?: unknown }).surfaceOp
      return typeof op === 'object' && op !== null && (op as { op?: unknown }).op === 'replace'
    }) as { surfaceOp?: { startSeq: number; endSeq: number }; seq?: number } | undefined
    // Not degraded: the range survived as a REMAPPED replace bound to the
    // rebased positions (not to the parent's dropped-span seq space).
    expect(rebased).toBeDefined()
    expect(rebased?.surfaceOp?.startSeq).toBeLessThan(rebased?.seq ?? 0)
    expect(rebased?.surfaceOp?.endSeq).toBeLessThan(rebased?.seq ?? 0)
  })

  it('trims when the protected head was rewritten mid-session (turn 1, later step)', () => {
    // Host shape: SystemPromptProjection.replace rewrites surface node 0 in
    // a LATER step of turn 1 — the surviving head node carries turn 1 / step
    // >= 2. The skeleton normalizes to turn 1 step 1 (envelope numbers only;
    // a user/message never gains fields) and the trim still fires.
    const events = [
      lo('turn/start', 0, { turn: 1 }),
      lo('step/start', 1, { turn: 1, step: 1 }),
      sf('system/message', 2, {
        turn: 1, step: 1,
        message: { id: 'm-sys', role: 'system', content: [{ type: 'text', text: 'original prompt' }], source: { kind: 'system-prompt' } },
      }),
      sf('user/message', 3, userMessage('m-q1', 'q1')),
      sf('assistant/message', 4, { turn: 1, step: 1, message: assistantMessage('a1'), stream: [] }),
      lo('step/end', 5, { turn: 1, step: 1 }),
      lo('step/start', 6, { turn: 1, step: 2 }),
      {
        ...sf('system/message', 7, {
          turn: 1, step: 2,
          message: { id: 'm-sys2', role: 'system', content: [{ type: 'text', text: 'rewritten prompt' }], source: { kind: 'system-prompt' } },
        }),
        surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
        sourceEventSeqs: [2],
      } as SidebarSessionEvent,
      lo('step/end', 8, { turn: 1, step: 2 }),
      lo('turn/end', 9, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const keep = turn(10, 2, { callId: 'c-keep', result: 'keep result' })
    events.push(...keep.events)
    events.push(...compactionGroup(events.length, [3, 4]))
    events.push(...turn(events.length, 3, { callId: 'c-tail', result: 'tail result' }).events)
    const { seed, snapshot } = buildSidechatInheritance(events)
    expect(snapshot).toBeNull()
    expect(seed.length).toBeLessThan(events.length)
    // The surviving head is the REWRITTEN prompt, skeleton-normalized to
    // turn 1 step 1; the original shadowed prompt is gone.
    expect(seed.some(event => JSON.stringify(event).includes('rewritten prompt'))).toBe(true)
    expect(seed.some(event => JSON.stringify(event).includes('original prompt'))).toBe(false)
    const head = seed.find(event => event.type === 'system/message') as { data?: { turn?: number; step?: number } }
    expect(head?.data?.turn).toBe(1)
    expect(head?.data?.step).toBe(1)
    expect(visibleSequence(seed)).toEqual(visibleSequence(events))
    expect(invariantFailures(seed)).toEqual([])
  })

  it('trims when the pruner rewrote a keep-window tool result mid-turn', () => {
    // Host shape: the tool-result-pruner appends a tool/result REPLACEMENT
    // between steps, carrying the ORIGINAL turn/step and a replace op over
    // its target. The target is not on the final surface, but it is the
    // replacement's fold target — it must be emitted so the transition
    // replays, and the record's citations must rebase.
    const events = [...systemHead(), ...oldSpan().events]
    // Turn 2 has two steps; the pruner runs at the pre-step boundary between
    // them (turn still open) and rewrites step 1's over-budget result.
    events.push(
      lo('turn/start', 9, { turn: 2 }),
      lo('step/start', 10, { turn: 2, step: 1 }),
      sf('user/message', 11, userMessage('m-q2', 'q2')),
      lo('tool/call', 12, { turn: 2, step: 1, callId: 'c-keep', name: 'bash', arguments: '{}' }),
      sf('tool/result', 13, { turn: 2, step: 1, message: toolResultMessage('c-keep', 'keep result') }),
      lo('step/end', 14, { turn: 2, step: 1 }),
      lo('compaction/prune', 15, {
        shadowedRange: { start: 13, end: 13 },
        shadowedSeqs: [13],
        shadowedTokenCount: 40,
      }),
      {
        ...sf('tool/result', 16, { turn: 2, step: 1, message: toolResultMessage('c-keep', 'pruned stub') }),
        surfaceOp: { op: 'replace', startSeq: 13, endSeq: 13 },
        sourceEventSeqs: [13],
      } as SidebarSessionEvent,
      lo('step/start', 17, { turn: 2, step: 2 }),
      sf('assistant/message', 18, { turn: 2, step: 2, message: assistantMessage('a2'), stream: [] }),
      lo('step/end', 19, { turn: 2, step: 2 }),
      lo('turn/end', 20, { turn: 2, reason: { kind: 'completed' } }),
    )
    events.push(...compactionGroup(events.length, [3, 5, 6]))
    events.push(...turn(events.length, 3, { callId: 'c-tail', result: 'tail result' }).events)
    const { seed, snapshot } = buildSidechatInheritance(events)
    expect(snapshot).toBeNull()
    expect(seed.length).toBeLessThan(events.length)
    // Both the original result (fold target) and its replacement survive,
    // the replacement keeps its replace op REMAPPED, and the prune record's
    // citations rebase to the seed's seq space.
    expect(seed.some(event => JSON.stringify(event).includes('keep result'))).toBe(true)
    expect(seed.some(event => JSON.stringify(event).includes('pruned stub'))).toBe(true)
    const replacement = seed.find(event => JSON.stringify(event).includes('pruned stub')) as { surfaceOp?: { op?: string; startSeq?: number }; seq?: number }
    expect(replacement?.surfaceOp?.op).toBe('replace')
    expect(replacement?.surfaceOp?.startSeq).toBeLessThan(replacement?.seq ?? 0)
    const record = seed.find(event => event.type === 'compaction/prune') as { data?: { shadowedSeqs?: number[] } }
    expect(record?.data?.shadowedSeqs?.[0]).toBe(replacement?.surfaceOp?.startSeq)
    expect(visibleSequence(seed)).toEqual(visibleSequence(events))
    expect(invariantFailures(seed)).toEqual([])
  })

  it('trims when the keep window opens on a turn whose inbox insert precedes its turn/start', () => {
    // Real loop order: [insert q][turn/start][claim q][step/start][user].
    // The keep window must swallow the insert ahead of the turn/start so
    // the positional inbox fold replays; without it the claim dangles and
    // Session.create rejects the seed (caught on the real deployment's
    // main session during e2e).
    const events = [...systemHead(), ...oldSpan().events]
    const shadowTurn = turn(9, 2, { callId: 'c-shadow', result: 'shadow result' })
    events.push(...shadowTurn.events)
    const at = events.length
    events.push(
      lo('agent/inbox/spliced', at, { target: 'next-turn', start: 0, removedCount: 0, inserted: [userMessage('m-q3', 'q3')] }),
      lo('turn/start', at + 1, { turn: 3 }),
      lo('agent/inbox/spliced', at + 2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      lo('step/start', at + 3, { turn: 3, step: 1 }),
      sf('user/message', at + 4, userMessage('m-q3', 'q3')),
      sf('assistant/message', at + 5, { turn: 3, step: 1, message: assistantMessage('a3'), stream: [] }),
      lo('step/end', at + 6, { turn: 3, step: 1 }),
      lo('turn/end', at + 7, { turn: 3, reason: { kind: 'completed' } }),
    )
    events.push(...compactionGroup(events.length, [3, 5, 6, 11, 13, 14]))
    events.push(...turn(events.length, 4, { callId: 'c-tail', result: 'tail result' }).events)
    const { seed, snapshot } = buildSidechatInheritance(events)
    expect(snapshot).toBeNull()
    expect(seed.length).toBeLessThan(events.length)
    // The insert rode along ahead of the keep window's turn/start, so the
    // claim finds its message and the inbox fold replays.
    const splices = seed.filter(event => event.type === 'agent/inbox/spliced')
    expect(splices.length).toBeGreaterThanOrEqual(2)
    expect(visibleSequence(seed)).toEqual(visibleSequence(events))
    expect(invariantFailures(seed)).toEqual([])
    // The real validator accepts (this is the layer that rejected the
    // pre-fix seed on the real session).
    const id = 'session-inbox-splice-acceptance'
    Session.create(
      id as SessionId,
      seed as never,
      { version: SESSION_FORMAT_VERSION, id: id as SessionId, createdAt: Date.now(), isSeeded: true },
      SessionLogOffset(seed.length),
    )
  })

  it('reuses the previous compaction when the newest summary is orphaned', () => {
    const events = compactedLog()
    const at = events.length
    // A second compaction whose replacement never landed (summary + error
    // end, no checkpoint): the builder must fall back to the EARLIER
    // complete compaction instead of the full copy.
    events.push(
      lo('compaction/start', at, { compactionId: 'cp-dead', turn: null }),
      lo('compaction/summary', at + 1, {
        compactionId: 'cp-dead',
        summary: [{ type: 'text', text: 'never landed' }],
        shadowedRange: { start: 3, end: 3 },
        shadowedSeqs: [3],
        shadowedTokenCount: 10,
        provider: 'deepseek',
        model: 'test-model',
        rawOutput: [],
        llmStreamCall: true,
      }),
      lo('compaction/end', at + 2, { compactionId: 'cp-dead', turn: null, error: 'summarizer failed' }),
    )
    const { seed } = buildSidechatInheritance(events)
    // The trim fired through the EARLIER compaction: the old span is gone
    // while the orphaned group's log-only records may ride along (the fold
    // never sees them, and they keep the parent's metering history honest).
    expect(seed.length).toBeLessThan(events.length)
    expect(seed.some(event => JSON.stringify(event).includes('old result'))).toBe(false)
  })
})
