/**
 * conversation-draft spec — the caret-resolved composer insertion (upstream
 * issue #425 ②). `insertAtCaret` is pure string math (splice with
 * whitespace-aware joins); `probeComposerCaret` reads the live composer
 * `<textarea>` selection out of the DOM, guarded by a value-sync check so a
 * stale or wrong-composer caret is never applied; `placeComposerCaretAfterInsert`
 * restores the caret right after the inserted text once the setDraft value
 * commit lands, keeping stacked inserts at their running position.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import {
  appendToDraft,
  foldClipboardOffset,
  insertAtCaret,
  insertDraftReference,
  placeComposerCaretAfterInsert,
  probeComposerCaret,
} from '../src/client/conversation-draft.ts'

/**
 * Mount a fake composer textarea inside the DSH conversation column
 * (`#root [data-slot="conversation"] textarea[data-phase]`).
 */
function mountComposer(draft: string, selectionStart: number, selectionEnd: number): HTMLTextAreaElement {
  const root = document.createElement('div')
  root.id = 'root'
  const column = document.createElement('div')
  column.setAttribute('data-slot', 'conversation')
  const textarea = document.createElement('textarea')
  textarea.setAttribute('data-phase', 'plain')
  textarea.value = draft
  textarea.setSelectionRange(selectionStart, selectionEnd)
  column.append(textarea)
  root.append(column)
  document.body.append(root)
  return textarea
}

afterEach(() => {
  document.body.innerHTML = ''
})

/** Let the scheduled caret placement (rAF or setTimeout fallback) settle. */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 30) })

describe('probeComposerCaret', () => {
  it('returns the textarea selection when the DOM is in sync with the draft', () => {
    mountComposer('hello world', 5, 5)
    expect(probeComposerCaret('hello world')).toEqual({ start: 5, end: 5 })
  })

  it('reports a live selection range, not just a collapsed caret', () => {
    mountComposer('hello world', 6, 11)
    expect(probeComposerCaret('hello world')).toEqual({ start: 6, end: 11 })
  })

  it('returns null when no composer is mounted', () => {
    expect(document.querySelector('textarea')).toBeNull()
    expect(probeComposerCaret('anything')).toBeNull()
  })

  it('returns null when the composer DOM value is out of sync with the store draft', () => {
    mountComposer('hello', 0, 0)
    expect(probeComposerCaret('hello changed on the server')).toBeNull()
  })

  it('returns null for a disabled composer', () => {
    const input = mountComposer('hello', 2, 2)
    input.disabled = true
    expect(probeComposerCaret('hello')).toBeNull()
  })

  it('returns null for a read-only composer', () => {
    const input = mountComposer('hello', 2, 2)
    input.readOnly = true
    expect(probeComposerCaret('hello')).toBeNull()
  })

  it('clamps out-of-range selections into the draft bounds', () => {
    const input = mountComposer('hi', 0, 0)
    // Direct property writes (jsdom does not enforce bounds like browsers).
    input.selectionStart = 5
    input.selectionEnd = 9
    expect(probeComposerCaret('hi')).toEqual({ start: 2, end: 2 })
  })
})

describe('insertAtCaret', () => {
  it('appends at the end when the caret is unknown (pre-fix behavior)', () => {
    expect(insertAtCaret('', 'X', null)).toBe('X')
    expect(insertAtCaret('hello', 'X', null)).toBe('hello X')
    expect(insertAtCaret('   ', 'X', null)).toBe('X')
  })

  it('keeps a directory separator when appending another reference', () => {
    expect(insertAtCaret('@src/ ', '@notes.md', null)).toBe('@src/ @notes.md')
    expect(insertAtCaret('@src/\n', '@notes.md', null)).toBe('@src/\n@notes.md')
  })

  it('uses the inserted directory separator before a following word', () => {
    expect(insertAtCaret('hello world', '@src/ ', { start: 6, end: 6 })).toBe('hello @src/ world')
  })

  it('inserts at the caret in the middle of a sentence with one space each side', () => {
    expect(insertAtCaret('hello world', 'CODE', { start: 5, end: 5 })).toBe('hello CODE world')
  })

  it('only adds the separating spaces the neighbors actually need', () => {
    expect(insertAtCaret('one two', 'CODE', { start: 3, end: 3 })).toBe('one CODE two')
    // Doubled gap, caret right after the word: the leading space is added,
    // the two after the caret stay untouched (like typing in the gap).
    expect(insertAtCaret('one  two', 'CODE', { start: 3, end: 3 })).toBe('one CODE  two')
    // Doubled gap, caret on the second space: neither side needs a new
    // space, both originals flank the insertion.
    expect(insertAtCaret('one  two', 'CODE', { start: 4, end: 4 })).toBe('one CODE two')
    expect(insertAtCaret('one two ', 'CODE', { start: 8, end: 8 })).toBe('one two CODE')
  })

  it('inserts at the start without a leading space', () => {
    expect(insertAtCaret('hello', 'CODE', { start: 0, end: 0 })).toBe('CODE hello')
  })

  it('inserts at the end with a single trailing space', () => {
    expect(insertAtCaret('hello', 'CODE', { start: 5, end: 5 })).toBe('hello CODE')
  })

  it('replaces the live selection', () => {
    expect(insertAtCaret('a little tale', 'CODE', { start: 2, end: 8 })).toBe('a CODE tale')
  })

  it('replaces a selection surrounded by words with single-space joins', () => {
    expect(insertAtCaret('abc def ghi', 'CODE', { start: 4, end: 7 })).toBe('abc CODE ghi')
  })

  it('replaces a selection spanning the whole draft', () => {
    expect(insertAtCaret('old', 'CODE', { start: 0, end: 3 })).toBe('CODE')
  })

  it('handles an empty draft with a resolved caret', () => {
    expect(insertAtCaret('', 'CODE', { start: 0, end: 0 })).toBe('CODE')
  })
})

describe('placeComposerCaretAfterInsert', () => {
  it('places the caret right after the inserted text once the value commits', async () => {
    const input = mountComposer('AB', 1, 1) // pre-insert draft still shown
    placeComposerCaretAfterInsert('A C B', 1 + 1)
    input.value = 'A C B' // the setDraft commit lands
    await tick()
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(2)
  })

  it('places the caret when the value already matches (no commit needed)', async () => {
    const input = mountComposer('A C B', 0, 0)
    placeComposerCaretAfterInsert('A C B', 2)
    await tick()
    expect(input.selectionStart).toBe(2)
  })

  it('clamps an out-of-range caret into the composer bounds', async () => {
    const input = mountComposer('A C B', 0, 0)
    placeComposerCaretAfterInsert('A C B', 99)
    await tick()
    expect(input.selectionStart).toBe(5)
  })

  it('does not clobber a composer that never matches the expected draft', async () => {
    const input = mountComposer('OLD', 0, 0)
    input.value = 'UNRELATED' // a competing update wins the race
    input.setSelectionRange(1, 1)
    placeComposerCaretAfterInsert('NEW DRAFT', 2)
    await tick()
    expect(input.selectionStart).toBe(1)
  })

  it('leaves the caret alone when no composer is mounted', async () => {
    placeComposerCaretAfterInsert('X', 0)
    await tick() // must not throw
    expect(document.querySelector('textarea')).toBeNull()
  })
})

describe('appendToDraft', () => {
  /** A fake ctx exposing the conversation service face appendToDraft uses. */
  function fakeCtx(
    getDraft: () => string,
    onSet: (next: string) => void,
    withConversation = true,
  ): Context {
    const input = {
      state: { getSnapshot: (): { draft: string } => ({ draft: getDraft() }) },
      setDraft: (next: string): void => { onSet(next) },
    }
    return {
      sessions: { scope: (): unknown => ({}) },
      get: (name: string): unknown =>
        withConversation && name === 'conversation'
          ? { input: { for: (): unknown => input } }
          : undefined,
    } as unknown as Context
  }

  it('splices at the probed caret and restores the caret right after the insert', async () => {
    const composer = mountComposer('AB', 1, 1)
    const calls: string[] = []
    const ctx = fakeCtx(() => 'AB', (next) => { calls.push(next); composer.value = next })
    expect(appendToDraft(ctx, 's1', 'C')).toBe(true)
    expect(calls).toEqual(['A C B'])
    await tick()
    // 'A C| B' — the caret sits right after the inserted text (the left
    // separating space shifts it past `start + text.length`).
    expect(composer.selectionStart).toBe(3)
    expect(composer.selectionEnd).toBe(3)
  })

  it('appends and places the caret at the end when the caret is unknown', async () => {
    const composer = mountComposer('hi', 0, 0)
    composer.value = 'hi changed' // out of sync → caret unresolved → append
    const calls: string[] = []
    const ctx = fakeCtx(() => 'hi', (next) => { calls.push(next); composer.value = next })
    appendToDraft(ctx, 's1', 'X')
    expect(calls).toEqual(['hi X'])
    await tick()
    expect(composer.selectionStart).toBe(4)
  })

  it('keeps stacked inserts at the running caret (A|B + C + D → ACD|B)', async () => {
    const composer = mountComposer('AB', 1, 1)
    let draft = 'AB'
    const ctx = fakeCtx(() => draft, (next) => { draft = next; composer.value = next })
    appendToDraft(ctx, 's1', 'C')
    await tick()
    expect(draft).toBe('A C B')
    expect(composer.selectionStart).toBe(3) // A C| B
    appendToDraft(ctx, 's1', 'D')
    await tick()
    expect(draft).toBe('A C D B')
    expect(composer.selectionStart).toBe(5) // A C D| B
  })

  it('returns false and logs when the conversation service is unavailable', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ctx = fakeCtx(() => '', (): void => undefined, false)
    expect(appendToDraft(ctx, 's1', 'X')).toBe(false)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
  })
})

describe('foldClipboardOffset', () => {
  // 'ab' + chip('docs/a.md:12') + ' cd' — the clipboard projection expands the
  // chip; the detect projection collapses it to one character.
  const draft = 'abdocs/a.md:12 cd'
  const occurrences = [{ offset: 2, length: 12 }]

  it('leaves an offset alone when the draft carries no chips', () => {
    expect(foldClipboardOffset('abcdef', [], 4)).toBe(4)
  })

  it('leaves an offset before the first chip untouched', () => {
    expect(foldClipboardOffset(draft, occurrences, 1)).toBe(1)
  })

  it('shrinks an offset past a chip by its expansion minus the placeholder', () => {
    // 'ab' + 1 placeholder + ' cd'
    expect(foldClipboardOffset(draft, occurrences, draft.length)).toBe(6)
  })

  it('lands right after the placeholder for an offset at the chip end', () => {
    expect(foldClipboardOffset(draft, occurrences, 14)).toBe(3)
  })

  it('snaps an offset inside the chip to its trailing edge', () => {
    expect(foldClipboardOffset(draft, occurrences, 8)).toBe(3)
  })

  it('reads an offset at the chip start as the position before it', () => {
    expect(foldClipboardOffset(draft, occurrences, 2)).toBe(2)
  })

  it('folds several chips independently', () => {
    // 'x' + chip('a.md:1') + ' ' + chip('b.md:2') + ' z'
    const two = 'xa.md:1 b.md:2 z'
    const chips = [{ offset: 1, length: 6 }, { offset: 8, length: 6 }]
    expect(foldClipboardOffset(two, chips, two.length)).toBe(6)
  })

  it('clamps an out-of-range offset into the draft', () => {
    expect(foldClipboardOffset('ab', [], 99)).toBe(2)
    expect(foldClipboardOffset('ab', [], -3)).toBe(0)
  })
})

/**
 * A fake composer exposing the conversation face these two functions use:
 * the snapshot store, the `insertReference` facade, and the session-scope
 * `emit` the span channel goes through. Every write records what it was
 * called with so a test can assert which channel ran.
 */
function composerCtx(options: {
  draft?: string
  occurrences?: { offset: number; length: number }[]
  draftRev?: number
  /** Omit the `insertReference` facade (an older host without chip support). */
  withChipChannel?: boolean
  /** Return false from the facade to simulate the host refusing the insert. */
  accept?: boolean
  withConversation?: boolean
} = {}) {
  let draft = options.draft ?? ''
  // `draftRev: undefined` is a meaningful case (a host with no revision), so
  // only an absent key takes the default.
  let rev: number | undefined = 'draftRev' in options ? options.draftRev : 0
  const bump = (): void => { if (rev !== undefined) rev += 1 }
  const setDrafts: string[] = []
  const emitted: { name: string; payload: unknown }[] = []
  const chipInserts: { ref: unknown; span: unknown }[] = []
  const input = {
    state: {
      getSnapshot: () => ({
        draft,
        ...rev === undefined ? {} : { draftRev: rev },
        occurrences: options.occurrences ?? [],
      }),
    },
    setDraft: (next: string): void => { setDrafts.push(next); draft = next; bump() },
    ...options.withChipChannel === false
      ? {}
      : {
          insertReference: (ref: unknown, span: unknown): boolean => {
            chipInserts.push({ ref, span })
            if (options.accept === false) return false
            bump()
            return true
          },
        },
  }
  const actx = {
    emit: (name: string, payload: unknown): void => {
      emitted.push({ name, payload })
      bump()
    },
  }
  const ctx = {
    sessions: { scope: (): unknown => actx },
    get: (name: string): unknown =>
      options.withConversation === false || name !== 'conversation'
        ? undefined
        : { input: { for: (): unknown => input } },
  } as unknown as Context
  return { ctx, emitted, setDrafts, chipInserts }
}

describe('insertDraftReference', () => {
  it('hands the host one chip carrying the label and the model text apart', () => {
    const fake = composerCtx({ draft: 'hello' })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a.md:3', text: '```a.md:3\nx\n```' })).toBe(true)
    expect(fake.chipInserts).toEqual([{
      ref: {
        source: 'reference',
        ref: '```a.md:3\nx\n```',
        label: 'a.md:3',
        appearance: 'file',
        clipboardText: 'a.md:3',
      },
      span: { draftRev: 0, start: 5, end: 5 },
    }])
  })

  it('folds the span past chips already in the draft', () => {
    const fake = composerCtx({ draft: 'abdocs/a.md:12 cd', occurrences: [{ offset: 2, length: 12 }] })
    insertDraftReference(fake.ctx, 's1', { label: 'b.md:1', text: 'B' })
    expect((fake.chipInserts[0]?.span as { start: number }).start).toBe(6)
  })

  it('reports false when the host refused the insert', () => {
    const fake = composerCtx({ draft: 'x', accept: false })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(false)
  })

  it('reports false when the host has no chip facade', () => {
    const fake = composerCtx({ draft: 'x', withChipChannel: false })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(false)
    expect(fake.chipInserts).toEqual([])
  })

  it('reports false when the host exposes no draft revision', () => {
    const fake = composerCtx({ draft: 'x', draftRev: undefined })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(false)
  })

  it('reports false when the conversation service is missing', () => {
    const fake = composerCtx({ withConversation: false })
    expect(insertDraftReference(fake.ctx, 's1', { label: 'a', text: 'a' })).toBe(false)
  })
})

describe('appendToDraft on a draft that already carries chips', () => {
  it('inserts through the span event instead of rebuilding the draft', () => {
    const fake = composerCtx({ draft: 'abdocs/a.md:12 cd', draftRev: 3, occurrences: [{ offset: 2, length: 12 }] })
    appendToDraft(fake.ctx, 's1', 'X')
    expect(fake.setDrafts).toEqual([])
    expect(fake.emitted).toHaveLength(1)
    expect(fake.emitted[0]?.name).toBe('slash/input-insert-text')
    const payload = fake.emitted[0]?.payload as { text: string; span: { start: number; end: number } }
    expect(payload.span).toEqual({ draftRev: 3, start: 6, end: 6 })
    // The draft ends in 'd', so the insert carries its own separating space.
    expect(payload.text).toBe(' X')
  })

  it('adds the separating space the draft end needs', () => {
    const fake = composerCtx({ draft: 'abdocs/a.md:12', draftRev: 3, occurrences: [{ offset: 2, length: 12 }] })
    appendToDraft(fake.ctx, 's1', 'X')
    expect((fake.emitted[0]?.payload as { text: string }).text).toBe(' X')
  })

  it('keeps the plain setDraft path when the draft has no chips', () => {
    const fake = composerCtx({ draft: 'hello', draftRev: 3 })
    appendToDraft(fake.ctx, 's1', 'X')
    expect(fake.emitted).toEqual([])
    expect(fake.setDrafts).toEqual(['hello X'])
  })
})