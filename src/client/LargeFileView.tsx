/**
 * The read-only paged preview for a file above the editable threshold.
 *
 * Two row shapes share one cursor ({@link useTextPager}):
 *
 * - `jsonl` — one row per record, collapsed to a one-line summary and
 *   expandable into the host's `JsonTree`. A page is line-aligned, so a page
 *   is exactly a run of whole records.
 * - everything else — one row per line, monospace, no wrapping (horizontal
 *   scroll), which is the log-viewer shape and the reason a page's row count
 *   stays bounded.
 *
 * The pager is EXPLICIT (previous/next page) rather than an infinite scroll.
 * Byte offsets only exist for pages already walked forward, so "scroll to the
 * end" cannot be offered honestly without indexing the whole file on open;
 * what the cursor CAN do is revisit any visited page in either direction, and
 * the pager says exactly that. See text-pages.ts for the full reasoning.
 *
 * Nothing here fetches the document: the file is above the editor's limit
 * precisely because holding it whole is what we are avoiding.
 */
import { useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular, JsonTree, type JsonTreeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionScope } from './api.ts'
import { downloadUrl } from './api.ts'
import { formatByteSize, MAX_EDITABLE_LABEL } from '../editor-limits.ts'
import { isJsonlPath, isTreeRecord, parseRecord, summarizeRecord } from './jsonl.ts'
import { splitLines, useTextPager } from './text-pages.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Copy the host's `JsonTree` needs; this plugin owns the wording. */
function jsonLabels(): JsonTreeLabels {
  return {
    // The tree's primitive/compact copy actions are the same gesture as the
    // code block's copy, so they reuse that wording rather than inventing a
    // second vocabulary for the same button.
    copyValue: t('copy'),
    copyJson: t('copy'),
    copyPath: t('jsonCopyPath'),
    copyPrettyJson: t('jsonCopyPrettyJson'),
    copyCompactJson: t('jsonCopyCompactJson'),
    copied: t('copied'),
    copyFailed: t('jsonCopyFailed'),
    collapseNode: t('jsonCollapseNode'),
    expandNode: t('jsonExpandNode'),
    copyButtonTitle: (action) => t('jsonCopyButtonTitle', { action }),
  }
}

/**
 * The read-only preview of one over-limit file.
 *
 * @param props.scope - the session scope.
 * @param props.path - the file being previewed.
 * @param props.size - the file's size in bytes (from the read that refused it).
 * @param props.visible - whether the tab is on screen; a parked tab stops reading.
 * @param props.revision - bumped by the host's refresh to restart from page 1.
 * @returns the preview.
 */
export function LargeFileView(props: {
  scope: SessionScope
  path: string
  size: number
  visible: boolean
  revision: number
}): ReactNode {
  const { scope, path, size, visible, revision } = props
  const pager = useTextPager(scope, path, visible, revision)
  const records = isJsonlPath(path)
  const rows = useMemo(() => splitLines(pager.text), [pager.text])
  /** Which record rows are expanded (reset with every page). */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const pageKey = `${pager.page}`
  const labels = useMemo(() => jsonLabels(), [])

  const parsed = useMemo(
    () => (records ? rows.map(parseRecord) : []),
    [records, rows],
  )

  /** Absolute line/record number of row `index` on the current page. */
  const numberAt = (index: number): number => pager.firstLine + index

  const selectPage = (next: () => void): void => {
    setExpanded(new Set())
    next()
  }

  return (
    <div className={css.largeFile}>
      <div className={css.largeFileNotice}>
        <span>{t('previewOnlyNotice', { size: formatByteSize(size), limit: MAX_EDITABLE_LABEL })}</span>
        <a className={css.largeFileDownload} href={downloadUrl(scope, path)} download>
          {t('downloadToView')}
        </a>
      </div>
      <div className={clsx(css.largeFileBody, records && css.largeFileRecords)}>
        {pager.error !== null && <div className={css.editorError}>{pager.error}</div>}
        {pager.error === null && pager.loading && pager.text === '' && (
          <div className={css.editorPlaceholder}>{t('loading')}</div>
        )}
        {pager.error === null && !(pager.loading && pager.text === '') && records && (
          <ol className={css.largeFileList} start={pager.firstLine}>
            {parsed.map((record, index) => (
              <RecordRow
                key={`${pageKey}:${index}`}
                number={numberAt(index)}
                line={rows[index] ?? ''}
                record={record}
                expanded={expanded.has(index)}
                labels={labels}
                onToggle={() => {
                  setExpanded((previous) => {
                    const next = new Set(previous)
                    if (next.has(index)) next.delete(index)
                    else next.add(index)
                    return next
                  })
                }}
              />
            ))}
          </ol>
        )}
        {pager.error === null && !(pager.loading && pager.text === '') && !records && (
          <div className={css.largeFileLines}>
            {rows.map((line, index) => (
              <div className={css.largeFileLine} key={`${pageKey}:${index}`}>
                <span className={css.largeFileLineNo} aria-hidden="true">{numberAt(index)}</span>
                <span className={css.largeFileLineText}>{line === '' ? '\u00a0' : line}</span>
              </div>
            ))}
            {rows.length === 0 && !pager.loading && (
              <div className={css.editorPlaceholder}>{t('largeFileEmpty')}</div>
            )}
          </div>
        )}
      </div>
      <div className={css.largeFilePager}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('pagedPrev')}
          title={t('pagedPrev')}
          disabled={pager.page <= 1 || pager.loading}
          onClick={() => { selectPage(pager.prev) }}
        >
          <IconChevronLeftOutlineRegular size={14} />
        </button>
        <span className={css.largeFilePageLabel}>
          {records
            ? t('jsonlRecordRange', { from: pager.firstLine, to: numberAt(Math.max(0, rows.length - 1)) })
            : t('pagedLineRange', { from: pager.firstLine, to: numberAt(Math.max(0, rows.length - 1)) })}
          {' · '}
          {pager.atEnd ? t('pagedPageOfTotal', { page: pager.page, total: pager.page }) : t('pagedPage', { page: pager.page })}
        </span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('pagedNext')}
          title={pager.atEnd ? t('pagedEnd') : t('pagedNext')}
          disabled={pager.atEnd || pager.loading}
          onClick={() => { selectPage(pager.next) }}
        >
          <IconChevronRightOutlineRegular size={14} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={pager.reload}
        >
          <IconRefreshOutlineRegular size={14} />
        </button>
      </div>
    </div>
  )
}

/** One JSONL record row: a summary line, expanding into the host's JSON tree. */
function RecordRow(props: {
  number: number
  /** The raw line, shown verbatim when the record does not parse. */
  line: string
  record: ReturnType<typeof parseRecord>
  expanded: boolean
  labels: JsonTreeLabels
  onToggle: () => void
}): ReactNode {
  const { number, line, record, expanded, labels, onToggle } = props
  if (!record.ok) {
    // A blank line is not a broken record — JSONL files normally end with one,
    // and the host's pages are line-aligned, so it lands as its own row.
    if (record.error === '') return null
    return (
      <li className={clsx(css.largeFileRecord, css.largeFileRecordInvalid)}>
        <span className={css.largeFileRecordNo} aria-hidden="true">{number}</span>
        <div className={css.largeFileRecordBody}>
          <div className={css.largeFileRecordSummary}>{t('jsonlInvalidRecord')}</div>
          <pre className={css.largeFileRecordRaw}>{line}</pre>
        </div>
      </li>
    )
  }
  const value = record.value
  const tree = isTreeRecord(value)
  return (
    <li className={clsx(css.largeFileRecord, expanded && css.largeFileRecordExpanded)}>
      <span className={css.largeFileRecordNo} aria-hidden="true">{number}</span>
      <div className={css.largeFileRecordBody}>
        <button
          type="button"
          className={css.largeFileRecordSummary}
          aria-expanded={tree ? expanded : undefined}
          disabled={!tree}
          onClick={onToggle}
        >
          {summarizeRecord(value)}
        </button>
        {tree && expanded && (
          <div className={css.largeFileRecordTree}>
            <JsonTree data={value} label={`#${number}`} labels={labels} copyable expandTopLevel />
          </div>
        )}
      </div>
    </li>
  )
}
