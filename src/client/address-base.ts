/**
 * The workspace root a session-scoped file ADDRESS is built and read with.
 *
 * DSH's address contract fixes that base to the session's STORED header cwd:
 * the host chat builds every file link with
 * `fileAddressFor(sessionId, ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd, path)`
 * (DSH `ui-chat`), and the host's own file resolver reads the relative path
 * back against `sessions.get(sessionId).header.cwd` (DSH `api-workspace-files`)
 * — the same value, so the host round-trips perfectly.
 *
 * The plugin does not: since #802 its filesystem routes follow the ACTIVE git
 * worktree, so an address's relative path re-resolved by a worktree-rooted
 * reader lands somewhere else entirely — doubled when the worktree sits inside
 * the stored cwd (`<repo>/frontend/.worktrees/wt/a.md` arrives as
 * `frontend/.worktrees/wt/a.md` and becomes
 * `<wt>/frontend/.worktrees/wt/a.md`, ENOENT — #947), or silently on the
 * same-named file of another checkout (#950).
 *
 * The rule that removes the whole family: an address's base is THIS value,
 * never the active worktree root, and an address's path is resolved to an
 * absolute one at the boundary where the address is read, so no
 * worktree-rooted code downstream ever sees a relative path it could re-base.
 * Live relative paths the user or the plugin intends (file tree, typed
 * paths, links inside a document) keep using the active root, which is what
 * `useSessionRoot` is for.
 *
 * @param ctx - client context carrying the session list.
 * @param sessionId - the session the address belongs to; `undefined` answers
 *   `undefined` so callers can fall back to their own cwd.
 * @returns the stored header cwd, or `undefined` when it is unknown (a
 *   stripped-down host or a bare test context).
 */
import type { Context } from '../context-types.ts'

export function addressBaseOf(ctx: Context, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  try {
    return ctx.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
  } catch {
    // A context without the session list (or with a broken one) keeps the
    // caller's own cwd; the address is no worse than before this helper.
    return undefined
  }
}
