/**
 * Native SVG parent-frontier graph. Reference inspected: microsoft/vscode
 * 76f9f309edc0682f4ef9465be8d12af754b87236 (MIT),
 * src/vs/workbench/contrib/scm/browser/scmHistory.ts. Independently implemented;
 * no upstream implementation copied. Full parent hashes, not ref decorations,
 * determine every edge, including parents beyond the loaded history page.
 */
import { useMemo, type MouseEvent, type ReactNode } from 'react'
import type { GitLogEntry } from '../api.ts'
import css from './changes.module.css'

const HEIGHT = 22
const STEP = 11
const COLORS = [
  'var(--dsw-alias-brand-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'var(--dsw-alias-state-business-primary)',
]

type Lane = { hash: string; child: string; color: string }
type GraphPath = { d: string; child: string; parent: string; color: string }
type GraphRow = { lane: number; color: string; input: Lane[]; output: Lane[]; paths: GraphPath[] }

function curve(from: number, fromY: number, to: number, toY: number): string {
  const x1 = (from + 1) * STEP
  const x2 = (to + 1) * STEP
  if (from === to) return `M ${x1} ${fromY} L ${x2} ${toY}`
  const middle = (fromY + toY) / 2
  return `M ${x1} ${fromY} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${toY}`
}

/** Newest-first, topological rows. Duplicate targets join only at their commit. */
export function layoutGraph(entries: readonly GitLogEntry[]): GraphRow[] {
  let frontier: Lane[] = []
  let nextColor = 0
  const color = (): string => COLORS[nextColor++ % COLORS.length]!

  return entries.map(entry => {
    const input = frontier
    const match = input.findIndex(lane => lane.hash === entry.hashFull)
    const lane = match < 0 ? input.length : match
    const nodeColor = input[match]?.color ?? color()
    const output: Lane[] = []
    const paths: GraphPath[] = []
    const firstParent = entry.parents[0]
    const addParent = (parent: string, parentColor: string): void => {
      paths.push({
        d: curve(lane, HEIGHT / 2, output.length, HEIGHT),
        child: entry.hashFull, parent, color: parentColor,
      })
      output.push({ hash: parent, child: entry.hashFull, color: parentColor })
    }

    input.forEach((edge, index) => {
      if (edge.hash === entry.hashFull) {
        paths.push({
          d: curve(index, 0, lane, HEIGHT / 2),
          child: edge.child, parent: edge.hash, color: edge.color,
        })
        if (index === match && firstParent) addParent(firstParent, nodeColor)
      } else {
        paths.push({
          d: curve(index, 0, output.length, HEIGHT),
          child: edge.child, parent: edge.hash, color: edge.color,
        })
        output.push(edge)
      }
    })
    if (match < 0 && firstParent) addParent(firstParent, nodeColor)
    for (const parent of entry.parents.slice(1)) addParent(parent, color())

    frontier = output
    return { lane, color: nodeColor, input, output, paths }
  })
}

export function GitGraph({ entries, selectedHash, onPreview, onContextMenu }: {
  entries: readonly GitLogEntry[]
  selectedHash?: string
  onPreview: (entry: GitLogEntry) => void
  onContextMenu: (event: MouseEvent, entry: GitLogEntry) => void
}): ReactNode {
  const rows = useMemo(() => layoutGraph(entries), [entries])
  const laneCount = rows.reduce((max, row) => Math.max(max, row.lane + 1, row.input.length, row.output.length), 1)
  const width = (laneCount + 1) * STEP

  return entries.map((entry, index) => {
    const row = rows[index]!
    const refs = [...new Set(entry.refs.split(',').flatMap(ref => ref.trim().split(' -> ')).filter(Boolean))]
    return (
      <div
        key={entry.hashFull}
        role="button"
        aria-pressed={selectedHash === entry.hashFull}
        tabIndex={0}
        className={css.logRow}
        data-graph-row={entry.hashFull}
        data-hash={entry.hashFull}
        data-selected={selectedHash === entry.hashFull ? 'true' : undefined}
        title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
        onClick={() => { onPreview(entry) }}
        onContextMenu={event => { event.preventDefault(); onContextMenu(event, entry) }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onPreview(entry)
          } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            event.currentTarget.dispatchEvent(new window.MouseEvent('contextmenu', {
              bubbles: true, cancelable: true,
              clientX: bounds.left + bounds.width / 2, clientY: bounds.bottom,
            }))
          }
        }}
      >
        <svg className={css.graphSvg} width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {row.paths.map((path, pathIndex) => (
            <path
              key={pathIndex}
              d={path.d}
              data-child={path.child}
              data-parent={path.parent}
              stroke={path.color}
              strokeWidth={1.5}
              fill="none"
            />
          ))}
          <circle cx={(row.lane + 1) * STEP} cy={HEIGHT / 2} r={3.5} fill={row.color} data-node={entry.hashFull} />
        </svg>
        <span className={css.graphContent}>
          {refs.length > 0 && <span className={css.logRefs}>
            {refs.map(ref => <span key={ref} className={css.logRef}>{ref}</span>)}
          </span>}
          <span className={css.logSubject}>{entry.subject}</span>
          <span className={css.logMeta}>{entry.author}</span>
        </span>
      </div>
    )
  })
}
