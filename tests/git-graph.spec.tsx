/** @vitest-environment jsdom */
import { act } from 'react-dom/test-utils'
import { expect, it, vi } from 'vitest'
import type { GitLogEntry } from '../src/client/api.ts'
import { GitGraph, layoutGraph } from '../src/client/changes/GitGraph.tsx'
import css from '../src/client/changes/changes.module.css'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

it('draws real fork/merge ancestry across page boundaries and preserves row activation', () => {
  const hash = (suffix: number): string => '1234567' + suffix.toString().padStart(33, '0')
  const entry = (id: number, parents: number[], refs = ''): GitLogEntry => ({
    hash: '1234567', hashFull: hash(id), parents: parents.map(hash),
    subject: `Commit ${id}`, author: 'Ada', date: '2026-10-13 12:00:00 +0800', refs,
  })
  // Merge -> two children -> shared parent, then a disconnected root. All
  // short hashes deliberately collide: ancestry must use full hashes only.
  const entries = [entry(1, [2, 3], 'HEAD -> main, origin/main, tag: v1'), entry(2, [4]), entry(3, [4]), entry(4, []), entry(5, [])]
  const page = layoutGraph(entries.slice(0, 2))
  const rows = layoutGraph(entries)
  expect(rows.slice(0, 2)).toEqual(page)
  expect(page[1]!.output.map(lane => lane.hash)).toEqual([hash(4), hash(3)])
  expect(rows.map(row => row.lane)).toEqual([0, 0, 1, 0, 0])
  expect(rows[1]!.input).toEqual(rows[0]!.output)
  expect(rows[2]!.input).toEqual(rows[1]!.output)
  expect(rows[0]!.color).toBe(rows[1]!.color)
  expect(rows[0]!.output[1]!.color).toBe(rows[2]!.color)
  expect(rows[2]!.output.map(lane => lane.hash)).toEqual([hash(4), hash(4)])
  expect(rows[3]!.paths.map(path => [path.child, path.parent])).toEqual([[hash(2), hash(4)], [hash(3), hash(4)]])
  expect(rows[3]!.paths.some(path => path.d.includes(' C '))).toBe(true)
  expect(rows[3]!.output).toEqual([])
  expect(rows[4]!.paths).toEqual([])
  expect(layoutGraph([])).toEqual([])
  const octopus = layoutGraph([entry(6, [7, 8, 9])])
  expect(octopus[0]!.output.map(lane => lane.hash)).toEqual([hash(7), hash(8), hash(9)])

  const onPreview = vi.fn()
  const onContextMenu = vi.fn()
  const render = (history: readonly GitLogEntry[]) => <GitGraph entries={history} selectedHash={hash(3)} onPreview={onPreview} onContextMenu={onContextMenu} />
  const view = renderRoot(render(entries.slice(0, 2)))
  try {
    const nodesBefore = [...view.container.querySelectorAll('circle')].map(node => [node.getAttribute('cx'), node.getAttribute('fill')])
    const pathsBefore = [...view.container.querySelectorAll('path')].map(path => path.getAttribute('d'))
    view.rerender(render(entries))
    const rowEls = view.container.querySelectorAll<HTMLElement>('[data-graph-row]')
    expect(rowEls.length).toBe(entries.length)
    expect(rowEls[2]!.dataset.selected).toBe('true')
    expect(rowEls[2]!.getAttribute('aria-pressed')).toBe('true')
    expect(rowEls[0]!.title).toContain(entries[0]!.hashFull)
    expect(rowEls[0]!.title).toContain(entries[0]!.date)
    expect(rowEls[0]!.title).toContain(entries[0]!.author)
    expect(rowEls[0]!.querySelector(`.${css.logSubject}`)?.textContent).toBe(entries[0]!.subject)
    expect(rowEls[0]!.querySelector(`.${css.logMeta}`)?.textContent).toBe(entries[0]!.author)
    expect([...rowEls[0]!.querySelectorAll(`.${css.logRef}`)].map(ref => ref.textContent)).toEqual(['HEAD', 'main', 'origin/main', 'tag: v1'])
    expect([...view.container.querySelectorAll('circle')].slice(0, 2).map(node => [node.getAttribute('cx'), node.getAttribute('fill')])).toEqual(nodesBefore)
    expect([...view.container.querySelectorAll('path')].slice(0, pathsBefore.length).map(path => path.getAttribute('d'))).toEqual(pathsBefore)
    expect(view.container.querySelectorAll('svg[aria-hidden="true"]').length).toBe(entries.length)
    // Width can be capped independently of the fixed row height. No vertical
    // letterboxing: parent edges must still meet at y=0/22 between rows.
    expect(view.container.querySelectorAll('svg[preserveAspectRatio="none"]').length).toBe(entries.length)
    const links = new Set([...view.container.querySelectorAll('path')].map(path => `${path.getAttribute('data-child')}/${path.getAttribute('data-parent')}`))
    expect(links).toEqual(new Set([`${hash(1)}/${hash(2)}`, `${hash(1)}/${hash(3)}`, `${hash(2)}/${hash(4)}`, `${hash(3)}/${hash(4)}`]))
    for (const glyph of view.container.querySelectorAll('path, circle')) {
      expect(glyph.getAttribute(glyph.tagName === 'path' ? 'stroke' : 'fill')).toMatch(/^var\(--dsw-alias-/)
    }
    act(() => {
      rowEls[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      rowEls[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      rowEls[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
      rowEls[2]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 15, clientY: 20 }))
      rowEls[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))
      rowEls[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(onPreview.mock.calls.map(call => call[0])).toEqual([entries[2], entries[2], entries[2]])
    expect(onContextMenu.mock.calls.map(call => call[1])).toEqual([entries[2], entries[2], entries[2]])
  } finally {
    view.unmount()
  }
})
