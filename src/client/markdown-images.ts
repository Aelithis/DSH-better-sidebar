/**
 * Local-image resolution for rendered markdown: the shared `MarkdownText`
 * (from @deepseek-ai/dsh-client-ui-primitives) only renders absolute http(s)
 * image URLs — relative links are disabled for chat security — so a local
 * image in a previewed `.md` (`![alt](./img.png)`, an absolute `/cwd/img.png`,
 * or a reference definition) or in a Side Chat prose row would otherwise fall
 * back to its alt text. This dependency-free helper rewrites those
 * destinations into absolute `/sidebar/file` media URLs, resolved against the
 * injected transport base so a reverse-proxy prefix survives; `MarkdownText`
 * accepts them because they are absolute http(s), and the host media route
 * then serves the bytes. Relative destinations resolve against the rendered
 * file's directory for a document, and against the session workspace root for
 * prose ({@link rewriteProseLocalImageUrls}).
 */

import type { SessionScope } from './api.ts'
import { hostRouteUrl } from './host-route-url.ts'
import { maskCodeRegions } from './markdown-code.ts'
import { isAbsolutePath } from './paths.ts'

/**
 * True for a destination that is a remote URL — an absolute `scheme:` URL
 * that is not a Windows drive path (`C:\...`). http/https/data/mailto etc.
 * all match here and are handed back to `MarkdownText` untouched.
 */
function isRemoteUrl(dest: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(dest) && !/^[A-Za-z]:[\\/]/.test(dest)
}

/**
 * Collapse `.`/`..` segments of an absolute local path, preserving its root
 * (POSIX `/`), its Windows drive (`C:\`), or its UNC `\\server\share`
 * prefix. The host's `requireAbsolute` (`path.resolve`) normalizes anyway,
 * but producing a canonical path here keeps the `/sidebar/file` URL clean.
 * Shared with the markdown navigation resolver (`markdown-navigation.ts`),
 * which canonicalizes a claimed link target the same way.
 */
export function normalizeLocalPath(path: string): string {
  const drive = /^([A-Za-z]:)[\\/]/.exec(path)?.[1]
  const body = drive !== undefined ? path.slice(drive.length) : path
  const parts = body.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  if (drive !== undefined) return `${drive}\\${out.join('\\')}`
  const separator = path.startsWith('\\') ? '\\' : '/'
  const root = path.startsWith('/') ? '/' : path.startsWith('\\') ? '\\\\' : ''
  return `${root}${out.join(separator)}`
}

/**
 * Resolve one media destination against the session's media route: local
 * (relative or absolute) paths become absolute `/sidebar/file` URLs, resolved
 * through `baseUrl` so the shared MarkdownText http(s) allowlist accepts them
 * AND a reverse-proxy prefix is preserved, while remote URLs, `#`-anchors and
 * empty destinations are returned untouched. Shared by the markdown image rewriter below and by the
 * preview's raw-HTML sanitizer (`markdown-html.tsx`, which meets the same
 * allowlist when rendering `<img src="./x.png">` inside HTML blocks).
 */
export function resolveLocalMediaDest(
  dest: string,
  scope: SessionScope,
  filePath: string,
  baseUrl: string,
): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const directory = slash === -1 ? '/' : filePath.slice(0, slash + 1)
  return resolveMediaDest(dest, scope, directory, baseUrl)
}

/**
 * One media destination against a base DIRECTORY (already path-separated):
 * the shared body of the file and prose variants. `undefined` leaves relative
 * destinations untouched — without a base there is nothing to resolve them
 * against, and a bare relative URL would just fail the host allowlist.
 */
function resolveMediaDest(
  dest: string,
  scope: SessionScope,
  directory: string | undefined,
  baseUrl: string,
): string {
  const trimmed = dest.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return dest
  if (isRemoteUrl(trimmed)) return dest
  const absolute = isAbsolutePath(trimmed)
  if (!absolute && directory === undefined) return dest
  const candidate = absolute ? trimmed : `${directory ?? ''}${trimmed}`
  // Mirrors api.ts fileUrl/mediaUrl for the /sidebar/file media route, made
  // absolute (and prefix-preserving) so the shared MarkdownText http(s)
  // allowlist accepts it.
  const params = new URLSearchParams({ sessionId: scope.sessionId, path: normalizeLocalPath(candidate) })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  return hostRouteUrl(`sidebar/file?${params.toString()}`, baseUrl).href
}

/** The directory a workspace root resolves relative destinations against. */
function workspaceDirectory(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  return `${cwd.replace(/[\\/]+$/, '')}/`
}

/**
 * Rewrite markdown image destinations that point at local files into
 * absolute `/sidebar/file` media URLs. Relative destinations resolve against
 * the opened file's directory (normalizing `.`/`..` segments); absolute
 * local paths pass through. Remote (http/https/data/mailto) and `#`-anchor
 * destinations are left untouched for `MarkdownText`. Reference-style images
 * (`![x][id]` + `[id]: url`) are covered by rewriting their definition lines.
 *
 * Code regions — inline spans AND fenced blocks, the latter opened by ``` ``` ```
 * OR `~~~` (see `markdown-code.ts`, the mask both source rewriters share) — are
 * masked before rewriting so documentation that demonstrates `![alt](./img.png)`
 * is not mutated into a `/sidebar/file` URL. Reference definitions are only
 * rewritten when their label is actually referenced by an image (collapsed
 * `[![][id]]`, full `![alt][id]`, or shortcut `![]` referencing the next
 * definition) — a plain link `[text][id]` must not have its destination
 * redirected to the media route.
 * @param text - The raw markdown source (inline + reference images).
 * @param scope - The session scope (sessionId + cwd) for the media route.
 * @param filePath - The absolute path of the opened `.md` file.
 * @param baseUrl - The injected transport base (`hostTransportBase()` in the
 * renderers); injected so the core rewrite stays pure and unit-testable.
 * @returns The markdown with local image destinations rewritten in place.
 */
export function rewriteLocalImageUrls(
  text: string,
  scope: SessionScope,
  filePath: string,
  baseUrl: string,
): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const directory = slash === -1 ? '/' : filePath.slice(0, slash + 1)
  return rewriteImageDestinations(text, (dest) => resolveMediaDest(dest, scope, directory, baseUrl))
}

/**
 * The prose counterpart of {@link rewriteLocalImageUrls}: a rendered
 * conversation row is not a file, so its relative destinations resolve
 * against the session workspace root instead of an opened document's
 * directory. Absolute local paths, remote URLs and code masking behave
 * exactly like the file variant (the shared MarkdownText only renders an
 * image whose destination is absolute http(s), so a local destination would
 * otherwise fall back to its alt text).
 * @param text - The markdown source of one prose row.
 * @param scope - The session scope (sessionId + cwd) for the media route.
 * @param cwd - The session workspace root; relative destinations resolve
 * against it (and stay untouched when it is unknown).
 * @param baseUrl - The injected transport base.
 * @returns The markdown with local image destinations rewritten in place.
 */
export function rewriteProseLocalImageUrls(
  text: string,
  scope: SessionScope,
  cwd: string | undefined,
  baseUrl: string,
): string {
  const directory = workspaceDirectory(cwd)
  return rewriteImageDestinations(text, (dest) => resolveMediaDest(dest, scope, directory, baseUrl))
}

/**
 * The masking + destination rewrite both variants share: code regions and
 * plain-link reference definitions stay out of it, and only the definitions an
 * image actually references are redirected.
 *
 * Text with no image syntax at all returns untouched: both regexes below key on
 * `![`, so the masking pass would only be paid for to be undone.
 */
function rewriteImageDestinations(text: string, resolve: (dest: string) => string): string {
  if (!text.includes('![')) return text
  // Fenced blocks (``` ``` ``` AND `~~~`) and inline code spans are masked so
  // image-looking text inside documentation examples is never rewritten; the
  // original text goes back in after the rewrite.
  const { masked, restore } = maskCodeRegions(text)

  const inline = masked.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, dest) => {
    return `![${alt}](${resolve(dest)})`
  })

  // Collect labels referenced by image syntax (full `![alt][id]` and
  // collapsed `![][id]`) so only those reference definitions are rewritten.
  // A shortcut reference (`![alt]` with no `[id]`) resolves to the label
  // text `alt` itself; include it too. Plain links `[text][id]` never match
  // the leading `!` and are left untouched.
  const imageLabels = new Set<string>()
  const labelRe = /!\[([^\]]*)\](?:\[((?:[^\][]|\[[^\]]*\])*)\])?/g
  let labelMatch: RegExpExecArray | null
  while ((labelMatch = labelRe.exec(inline)) !== null) {
    const alt = labelMatch[1] ?? ''
    const ref = labelMatch[2]
    imageLabels.add(ref !== undefined && ref !== '' ? ref.toLowerCase() : alt.toLowerCase())
  }

  const refsRewritten = inline.replace(/^(\s*\[([^\]]+)\]:\s*)(<[^>]+>|[^\s]+)/gm, (match, head: string, label: string, dest: string) => {
    if (!imageLabels.has(label.toLowerCase())) return match
    return `${head}${resolve(dest.replace(/^<|>$/g, ''))}`
  })

  return restore(refsRewritten)
}
