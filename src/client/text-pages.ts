/**
 * Byte-offset paging over one text file, shared by every over-limit preview
 * (the generic read-only text reader and the JSONL record list).
 *
 * Why paging at all: the editor answers "this file is too big to edit" by
 * refusing to show it (VS Code pops a placeholder and offers "Open Anyway").
 * That is safe but useless for the files people actually want to LOOK at —
 * session logs, eval dumps, dataset rows — so instead of refusing, this reads
 * the file in windows and renders one window at a time. Memory stays flat
 * whatever the file weighs.
 *
 * The cursor model, and its one honest limitation:
 *
 * - `pageStarts[i]` is the byte offset page `i` starts at. It is filled in as
 *   the reader walks FORWARD, so it is only known up to the furthest page
 *   visited — byte offsets cannot be computed backwards.
 * - Therefore navigation reaches any VISITED page in either direction, plus
 *   the next unvisited one. There is no "jump to the last page" and no total
 *   page count until the file is read to the end. A random-access index would
 *   mean scanning the whole file on open, which is exactly the cost paging
 *   exists to avoid.
 * - Decoded page text is cached separately from the page table, in a bounded
 *   LRU, so revisiting a page does not re-read it while memory still cannot
 *   grow with the file.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SessionScope } from './api.ts'

/** How many decoded pages stay in memory (the page table is tiny and unbounded). */
const PAGE_CACHE_MAX = 24

/** The cursor state one preview renders from. */
export interface TextPager {
  /** Whether a load is in flight (the first page included). */
  loading: boolean
  /** Wire/transport failure of the last load; cleared once one succeeds. */
  error: string | null
  /** The current page's text; '' before the first load settles. */
  text: string
  /** 1-based page number. */
  page: number
  /** Absolute 1-based line number the current page starts at. */
  firstLine: number
  /** The file's size in bytes (0 until the first page reports it). */
  size: number
  /** True once the file's last page has been loaded. */
  atEnd: boolean
  /** 1-based number of the furthest page reachable right now. */
  lastReachable: number
  /** True when a page after the current one is reachable (possibly not yet read). */
  hasNext: boolean
  next: () => void
  prev: () => void
  /** Re-read from page 1 (the toolbar's refresh, and the conflict banner's action). */
  reload: () => void
  /** The file's detected encoding, as reported by the first page. */
  encoding: string
}

/**
 * Page through one file.
 *
 * @param scope - the session scope.
 * @param path - the file to read ('' parks the hook).
 * @param enabled - false issues no request and keeps the previous state (a
 *  viewer that is merely hidden must not keep reading).
 * @param revision - bump to restart from page 1 (the host's refresh path).
 * @returns the cursor and its navigation commands.
 */
export function useTextPager(
  scope: SessionScope,
  path: string,
  enabled: boolean,
  revision: number,
): TextPager {
  /** `pageStarts[i]` = byte offset page `i` starts at; one extra slot past the
   *  last loaded page holds where the next one begins. */
  const [pageStarts, setPageStarts] = useState<number[]>([0])
  /** Absolute 1-based first line of each page, chained as pages are read. */
  const [lineStarts, setLineStarts] = useState<number[]>([1])
  /** Page index → decoded text, insertion-ordered for the LRU trim. */
  const cacheRef = useRef(new Map<number, string>())
  /** Mirror of `pageStarts` for the identity-stable `load` callback. */
  const startsRef = useRef(pageStarts)
  startsRef.current = pageStarts
  const linesRef = useRef(lineStarts)
  linesRef.current = lineStarts

  const [page, setPage] = useState(0)
  const [size, setSize] = useState(0)
  const [atEnd, setAtEnd] = useState(false)
  const [encoding, setEncoding] = useState('utf8')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Bumped after every cache write so the returned memo re-reads it. */
  const [cacheStamp, setCacheStamp] = useState(0)
  const [reloadSeq, setReloadSeq] = useState(0)
  const inFlight = useRef<Set<number>>(new Set())
  /** Guards a late response from the previous file/revision. */
  const generationRef = useRef(0)

  const reset = useCallback((): void => {
    generationRef.current += 1
    cacheRef.current = new Map()
    inFlight.current = new Set()
    setPageStarts([0])
    setLineStarts([1])
    setPage(0)
    setSize(0)
    setAtEnd(false)
    setError(null)
    setLoading(false)
    setCacheStamp(stamp => stamp + 1)
  }, [])

  // A new file restarts the cursor; so does the host's refresh — the file may
  // have moved on disk, and a stale byte offset would splice two different
  // revisions of the document together.
  useEffect(() => {
    reset()
    setReloadSeq(sequence => sequence + 1)
  }, [reset, path, scope.sessionId, scope.cwd, revision])

  const load = useCallback((index: number): void => {
    if (inFlight.current.has(index)) return
    const offset = index === 0 ? 0 : startsRef.current[index]
    if (offset === undefined) return
    const generation = generationRef.current
    inFlight.current.add(index)
    setLoading(true)
    setError(null)
    api.fsReadPage(scope, path, offset).then((result) => {
      inFlight.current.delete(index)
      if (generation !== generationRef.current) return
      const cache = cacheRef.current
      cache.set(index, result.text)
      while (cache.size > PAGE_CACHE_MAX) {
        const oldest = cache.keys().next()
        if (oldest.done || oldest.value === index) break
        cache.delete(oldest.value)
      }
      setPageStarts((previous) => {
        // Chaining the page table HERE (rather than in a separate effect) keeps
        // "page i was read" and "page i+1 starts at X" one atomic update: no
        // render can observe a table that skips the page it just saw.
        const next = [...previous]
        if (next[index] === undefined) next[index] = result.offset
        next[index + 1] = result.nextOffset
        return next
      })
      setLineStarts((previous) => {
        const next = [...previous]
        next[index] = previous[index] ?? 1
        next[index + 1] = next[index]! + lineCount(result.text)
        return next
      })
      setSize(result.size)
      setEncoding(result.encoding)
      setAtEnd(result.eof)
      setPage(index)
      setLoading(false)
      setCacheStamp(stamp => stamp + 1)
    }).catch((reason: unknown) => {
      inFlight.current.delete(index)
      if (generation !== generationRef.current) return
      setLoading(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [scope, path])

  const reload = useCallback(() => {
    reset()
    setReloadSeq(sequence => sequence + 1)
  }, [reset])

  // Load the current page when it is not cached yet. A page past the table's
  // reach has no known offset and must not be requested.
  useEffect(() => {
    void reloadSeq
    if (!enabled || path === '') return
    if (cacheRef.current.has(page)) return
    if (page > 0 && page >= startsRef.current.length) return
    load(page)
  }, [enabled, path, page, load, cacheStamp, reloadSeq])

  const current = cacheRef.current.get(page)
  const lastReachable = Math.max(1, pageStarts.length)

  const next = useCallback(() => {
    setPage(currentPage => (currentPage + 1 < Math.max(1, startsRef.current.length) ? currentPage + 1 : currentPage))
  }, [])
  const prev = useCallback(() => { setPage(currentPage => Math.max(0, currentPage - 1)) }, [])

  return useMemo<TextPager>(() => ({
    loading,
    error,
    text: current ?? '',
    page: page + 1,
    firstLine: lineStarts[page] ?? 1,
    size,
    atEnd,
    lastReachable,
    hasNext: !atEnd && page + 1 < lastReachable,
    next,
    prev,
    reload,
    encoding,
    // `cacheStamp` is the cache-generation signal this memo reads through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [loading, error, current, page, lineStarts, size, atEnd, lastReachable, next, prev, reload, encoding, cacheStamp])
}

/** Lines in one page's text (a trailing newline does not open a new line). */
export function lineCount(text: string): number {
  return splitLines(text).length
}

/**
 * One page's text as rows. The host trims every page to a line break, so the
 * '' a trailing newline produces is dropped — except on an empty page, which is
 * no rows rather than one empty one.
 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
