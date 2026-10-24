/**
 * Insert text into the current session's composer draft through the
 * conversation service — the shared path behind the explorer's @-reference
 * button and the viewer selection popup. The service is resolved lazily
 * through `ctx.get` (the inject-free read the app's own plugins use); a
 * missing service or scope degrades to a logged no-op, never a crash.
 *
 * Structured references (file chips, selection chips, and any append onto a
 * draft that already carries chips) go through the host's span channels
 * instead of plain draft text: `setDraft` rebuilds the document from a string
 * and flattens every chip. A reference chip mints through
 * `SidebarSessionInput.insertReference` (what the native `@` picker
 * calls); plain-text insertion onto a chipped draft has no facade method and
 * emits `slash/input-insert-text` directly. Plain `setDraft` is the fallback
 * for chipless drafts only.
 *
 * Insert position (fixes upstream issue #425): on a chipless draft the text
 * store exposes no caret API, so the composer's `<textarea>` selection is
 * probed from the DOM (guarded by a value-sync check) and the text spliced
 * there, replacing any live selection — with whitespace-aware joins, an
 * insert into the middle of a sentence keeps single-space separation like
 * the append path. An unknown/stale caret falls back to appending at the
 * end (the pre-fix behavior).
 *
 * The caret is also *restored* after the insert: committing a programmatic
 * draft change resets the controlled textarea's caret (observed landing at
 * the start of the value), which would make every later insert probe the
 * reset position and drift the stack (A|B + C + D ended up as |DACB). The
 * placement (`placeComposerCaretAfterInsert`) puts the caret right after the
 * inserted text once the value commit lands — the index accounts for the
 * separating space on the left, so stacked inserts stay at their running
 * position (A|B + C + D → ACD|B).
 */
import type {
  Context,
  SidebarConversation,
  SidebarReferenceInsert,
  SidebarSessionOccurrence,
} from '../context-types.ts'
import { baseName, workspaceRelativePath } from './paths.ts'

/**
 * One structured reference to insert as a chip: the compact `label` the
 * composer shows, and the `text` the model receives on send. The two are
 * deliberately different — a selection reads as `docs/a.md:12-15` on screen
 * while the model still gets the whole fenced block.
 */
export interface DraftReference {
  label: string
  text: string
  /**
   * What the draft string carries for this chip (the clipboard projection).
   * Defaults to `label`; a file reference spells its `@path` here instead.
   * Keep it short: this is the form a remounted session re-seeds the draft
   * from, and it cannot be turned back into a chip.
   */
  clipboardText?: string
}

/** A resolved composer caret/selection in draft coordinates. */
export interface DraftCaret {
  start: number
  end: number
}

/**
 * The spliced draft plus the caret index right after the inserted text — the
 * left-side separating space shifts it by one, which naive
 * `start + text.length` misses (it would land before the tail).
 */
interface SpliceResult {
  draft: string
  caretAfter: number
}

/**
 * The separating space an insert at `caret` needs on its left — one space,
 * but never doubled against existing whitespace or the string start. Both
 * the string splice and the span channel (which does no splice math of its
 * own) obey this single rule. A blank draft takes no separator: it is
 * replaced outright.
 */
function leadFor(draft: string, caret: DraftCaret | null): string {
  if (draft.trim() === '') return ''
  if (caret === null || draft === '') return /\s$/.test(draft) ? '' : ' '
  const prefix = draft.slice(0, caret.start)
  return prefix === '' || /\s$/.test(prefix) ? '' : ' '
}

/**
 * Splice `text` into `draft` at `caret` (replacing any live selection) with
 * whitespace-aware joins and report the caret position right after the
 * inserted text. `caret === null` (position unknown) appends at the end,
 * exactly like the original behavior.
 */
function spliceInsert(draft: string, text: string, caret: DraftCaret | null): SpliceResult {
  if (draft.trim() === '') return { draft: text, caretAfter: text.length }
  const lead = leadFor(draft, caret)
  if (caret === null || draft === '') {
    const next = `${draft}${lead}${text}`
    return { draft: next, caretAfter: next.length }
  }
  const prefix = draft.slice(0, caret.start)
  const suffix = draft.slice(caret.end)
  // One separating space on the right too, under the same rule — mirrors how
  // typing in the middle of a sentence behaves.
  const right = suffix === '' || /^\s/.test(suffix) || /\s$/.test(text) ? '' : ' '
  return {
    draft: `${prefix}${lead}${text}${right}${suffix}`,
    caretAfter: prefix.length + lead.length + text.length,
  }
}

/**
 * The spliced draft string (see {@link spliceInsert}); pure string math —
 * unit-tested directly.
 */
export function insertAtCaret(draft: string, text: string, caret: DraftCaret | null): string {
  return spliceInsert(draft, text, caret).draft
}

/**
 * Locate the composer `<textarea>` in the conversation column: prefer the
 * `data-phase`-tagged textarea (the composer's marker), falling back to any
 * textarea in the column, then to a bare data-phase textarea (older host
 * layouts without the column attribute). Null in jsdom-less hosts.
 */
function findComposerTextarea(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null
  const column = document.querySelector('#root [data-slot="conversation"]')
  const find = (scope: ParentNode): HTMLTextAreaElement | null =>
    scope.querySelector('textarea[data-phase]') ?? scope.querySelector('textarea')
  return column !== null
    ? find(column)
    : document.querySelector<HTMLTextAreaElement>('textarea[data-phase]')
}

/**
 * Resolve the composer's live caret from its DOM `<textarea>`. The draft
 * store has no caret API, so the sidebar reads the composed input's selection
 * directly; the value-sync check (`el.value === draft`) discards stale or
 * wrong-composer reads — a caret must never be applied against a draft it
 * was not measured on.
 *
 * Returns null when the composer is missing, disabled/read-only, out of
 * sync with the store draft, or has no measurable selection (jsdom/odd
 * hosts report null selectionStart/End).
 */
export function probeComposerCaret(draft: string): DraftCaret | null {
  const el = findComposerTextarea()
  if (el === null || el.disabled || el.readOnly) return null
  if (el.value !== draft) return null
  let start = el.selectionStart
  let end = el.selectionEnd
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  start = Math.max(0, Math.min(start, draft.length))
  end = Math.max(start, Math.min(end, draft.length))
  return { start, end }
}

/**
 * Restore the composer caret to `caretIndex` after a programmatic
 * `setDraft` commit. A controlled textarea update resets the caret (React
 * commits the value asynchronously and the browser moves the caret to the
 * start/end), so the placement is scheduled and retried across at most two
 * animation frames (setTimeout fallback for jsdom), and only applied when
 * the textarea still matches `expectedDraft` — a newer edit or a different
 * composer wins the race untouched. The caret is clamped into the value
 * bounds, mirroring how browsers clamp type-in positions.
 */
export function placeComposerCaretAfterInsert(expectedDraft: string, caretIndex: number): void {
  let remaining = 2
  let scheduled = false
  const schedule = (fn: () => void): void => {
    if (scheduled) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn)
    else setTimeout(fn, 0)
  }
  const place = (): void => {
    scheduled = false
    if (remaining <= 0) return
    remaining -= 1
    const el = findComposerTextarea()
    if (el === null || el.disabled || el.readOnly) return
    if (el.value !== expectedDraft) {
      // The commit has not landed yet (or a competing edit won) — one more
      // frame before giving up.
      schedule(place)
      return
    }
    const clamped = Math.max(0, Math.min(caretIndex, el.value.length))
    el.setSelectionRange(clamped, clamped)
  }
  schedule(place)
}

/**
 * Fold one clipboard-projection offset to its detect-projection twin.
 *
 * The host maintains two coordinate systems over the same document: the
 * clipboard projection (`InputState.draft`, `occurrences`) expands every chip
 * to its whole `clipboardText`, while the detect projection — the one every
 * insert/replace event's `span` must speak — collapses each chip to a single
 * placeholder character. Deriving a span from a draft offset without folding
 * therefore overshoots by `length - 1` per chip, and the host rejects the
 * out-of-range span (`applied = false`) — the second chip insert of a session
 * would silently fail.
 *
 * An offset inside a chip's expansion snaps to that chip's trailing edge: the
 * host only ever replaces whole chips, never splits one. An offset exactly at
 * a chip's START resolves to the position BEFORE the chip — the host's own
 * `detectOffsetOfClipboardOffset` reads that case as "inside" and returns the
 * trailing edge, which would move a caret one chip too far right.
 */
export function foldClipboardOffset(
  draft: string,
  occurrences: readonly SidebarSessionOccurrence[],
  offset: number,
): number {
  const target = Math.max(0, Math.min(offset, draft.length))
  let shrink = 0
  for (const occurrence of occurrences) {
    const end = occurrence.offset + occurrence.length
    if (target >= end) {
      // The whole chip sits at or before the offset: it contributes one
      // character instead of its expansion.
      shrink += occurrence.length - 1
      continue
    }
    if (target > occurrence.offset) {
      // Inside the chip's expansion — the host only replaces whole chips, so
      // snap to this chip's trailing edge.
      return occurrence.offset - shrink + 1
    }
    break
  }
  return target - shrink
}

/**
 * Mint one reference chip through the host's own `insertReference` — the
 * same facade method the native `@` picker's event listener calls, so the
 * composer shows a compact chip while the model receives `reference.text`.
 * The host runs its own admission-phase and revision guards and reports
 * whether the edit applied.
 *
 * The chip's `clipboardText` is the compact `label`, not the full payload:
 * the clipboard projection is what survives a session remount (the host
 * re-seeds a draft from that string), and a full fenced block there would
 * re-expand into the very wall of text this chip exists to avoid. The model
 * text rides in `ref`, which is serialized back to its full form on send.
 *
 * Returns false when the host refused the insert (stale revision, a frozen
 * submission phase, or no chip channel at all) so the caller can fall back.
 */
export function insertDraftReference(
  ctx: Context,
  sessionId: string,
  reference: DraftReference,
): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const snapshot = input.state.getSnapshot()
    if (input.insertReference === undefined || snapshot.draftRev === undefined) return false
    // Chips always append at the document end (there is no caret API and the
    // composer is a contenteditable, not a textarea — `probeComposerCaret`
    // never resolves one), so the span is the folded end position.
    const at = foldClipboardOffset(snapshot.draft, snapshot.occurrences ?? [], snapshot.draft.length)
    const chip: SidebarReferenceInsert = {
      source: 'reference',
      ref: reference.text,
      label: reference.label,
      appearance: 'file',
      clipboardText: reference.clipboardText ?? reference.label,
    }
    return input.insertReference(chip, { draftRev: snapshot.draftRev, start: at, end: at })
  } catch (error) {
    console.warn('[dsh-better-sidebar] reference chip insert failed:', error)
    return false
  }
}

/**
 * Insert `text` into the session's composer draft at the composer's live
 * caret (see {@link probeComposerCaret}), falling back to appending at the
 * end when the caret cannot be resolved. Returns false — and logs — when the
 * conversation service or the session scope is unavailable.
 */
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) {
      console.warn('[dsh-better-sidebar] draft insert skipped: no session scope', sessionId)
      return false
    }
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) {
      console.warn('[dsh-better-sidebar] draft insert skipped: conversation service unavailable')
      return false
    }
    const input = conversation.input.for(actx)
    const snapshot = input.state.getSnapshot()
    const draft = snapshot.draft
    const occurrences = snapshot.occurrences ?? []
    const caret = probeComposerCaret(draft)
    if (occurrences.length > 0) {
      // `setDraft` rebuilds the document from a plain string, which flattens
      // every existing chip into its text — so on a draft that already
      // carries chips, insert through the span event instead. The host's
      // `SessionInput` has no plain-text facade method (`insertText` lives on
      // the InputBar-private `InputActions`), so this event is the only
      // channel that preserves chips.
      if (snapshot.draftRev === undefined) {
        // No revision means no span channel either — the only remaining write
        // path (`setDraft`) would flatten every chip, so refuse instead.
        console.warn('[dsh-better-sidebar] draft insert skipped: chip draft without a revision')
        return false
      }
      const at = foldClipboardOffset(draft, occurrences, caret === null ? draft.length : caret.start)
      // The session-scope Context's typed `emit` is keyed to DSH's closed
      // event map; this internal composer event is string-loose at runtime.
      const actxEmit = actx as unknown as { emit(name: string, payload: unknown): void }
      actxEmit.emit('slash/input-insert-text', {
        text: `${leadFor(draft, caret)}${text}`,
        span: { draftRev: snapshot.draftRev, start: at, end: at },
      })
      return input.state.getSnapshot().draftRev !== snapshot.draftRev
    }
    const splice = spliceInsert(draft, text, caret)
    input.setDraft(splice.draft)
    // Put the caret right after the inserted text once the value commit
    // lands — see the module doc for why this keeps stacked inserts at the
    // running position.
    placeComposerCaretAfterInsert(splice.draft, splice.caretAfter)
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] draft insert failed:', error)
    return false
  }
}

/**
 * Insert one reference as a chip, degrading to its plain-text form when the
 * host has no chip channel or refuses the insert. This is the ONE place the
 * fallback policy lives: the explorer's `@` button and the viewer selection
 * popup both come through here.
 */
export function insertReferenceOrText(
  ctx: Context,
  sessionId: string,
  reference: DraftReference,
  fallbackText: string = reference.text,
): boolean {
  return insertDraftReference(ctx, sessionId, reference) || appendToDraft(ctx, sessionId, fallbackText)
}

/**
 * The DSH `@` spelling for one relative path, mirroring the host grammar
 * (`formatFileMention` in `@deepseek-ai/dsh-file-reference`): plain when
 * there is no whitespace, quoted when there is, and `undefined` when the
 * path contains a control character or an embedded quote the editor grammar
 * cannot represent.
 *
 * Files and folders share this one constructor so the quoting rule cannot
 * drift between them. A folder spells the trailing slash *inside* the quotes
 * (`@"my dir/"`, `@docs/`): the host's folder token matcher
 * (`FOLDER_REF_RE` in `dsh-client-ui-conversation`) only accepts a quoted
 * directory once the quote closes, and the message bubble's tokenizer
 * (`@"[^"\n]+"` in `dsh-client-ui-primitives`) only classifies a closed
 * quoted token as a folder — unquoted `@my dir/` decorates as a file chip
 * covering just `my`. The host's own picker emits the *open* form
 * (`@"my dir/`) while the user is still descending through completion; a
 * programmatic reference is a finished mention, so it closes the quote.
 */
export function mentionFor(
  relativePath: string,
  kind: 'file' | 'folder',
): { mention: string; label: string } | undefined {
  const path = relativePath.replace(/[\\/]+$/, '')
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this guard
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const target = kind === 'folder' ? `${path}/` : path
  const mention = /\s/u.test(target) ? `@"${target}"` : `@${target}`
  return { mention, label: baseName(path) }
}

/**
 * A complete directory token (`@docs/`, `@"my dir/"`): the explorer inserts a
 * finished mention, so the trailing slash sits inside the closing quote.
 * Separators normalize to '/' first (the fs-tree spelling); the spelling
 * itself is {@link mentionFor}'s single job, folder kind — this helper adds no
 * quoting rule of its own.
 */
export function directoryMention(relativePath: string): string | undefined {
  return mentionFor(relativePath.replace(/\\/g, '/'), 'folder')?.mention
}

/**
 * Insert an explorer entry using WorkspaceView.path, selected by exact
 * session membership (the same lookup as the native conversation shell).
 * Read the public workspace snapshot at click time so reconnects and session
 * changes cannot leave a captured root stale. Missing/unready membership or
 * an unrepresentable path is a logged no-op; never guess from session cwd.
 */
export function insertWorkspaceReference(ctx: Context, sessionId: string, path: string, isDir: boolean): boolean {
  try {
    const snapshot = ctx.get('workspaces')?.list.getSnapshot()
    const root = snapshot?.phase === 'ready' && snapshot.state === 'idle'
      ? snapshot.items.find(workspace => workspace.sessionIds.includes(sessionId))?.path
      : undefined
    const relative = workspaceRelativePath(root, path)
    if (relative === undefined) {
      console.warn('[dsh-better-sidebar] reference insert skipped: workspace root unavailable or path outside workspace')
      return false
    }
    const mention = isDir ? directoryMention(relative) : mentionFor(relative, 'file')?.mention
    if (mention === undefined) {
      console.warn('[dsh-better-sidebar] reference insert skipped: path cannot be represented as a mention')
      return false
    }
    // The host adds space after a file chip, but not before it. Complete
    // directory inserts need their own separator for the next @ click.
    if (isDir) return appendToDraft(ctx, sessionId, `${mention} `)
    const file = mentionFor(relative, 'file')
    if (file === undefined) return false
    return insertReferenceOrText(ctx, sessionId, {
      label: file.label,
      text: file.mention,
      clipboardText: file.mention,
    })
  } catch (error) {
    console.warn('[dsh-better-sidebar] workspace-reference insert failed:', error)
    return false
  }
}
