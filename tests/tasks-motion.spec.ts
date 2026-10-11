/**
 * The Tasks page's motion contract, pinned where a refactor would break it
 * silently:
 *
 * - the CANVAS must not run a FLIP library. Its card layer carries the fit's
 *   `transform: scale(k)`, and `@formkit/auto-animate` pins a leaving card with
 *   absolute `left/top` from `getBoundingClientRect()` (a box a scaled layer
 *   cannot express — the card jumps) and translates movers in unscaled units
 *   (k× the true distance). Attached there, it was reported as "折叠展开的动效
 *   都特别怪"; the canvas uses the CSS entrance on `.node` instead.
 * - the FLOW surfaces (tree rows, jobs rows) are where FLIP belongs, and they
 *   keep it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** One source file of the client half. */
function source(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8')
}

describe('Tasks page motion', () => {
  it('keeps the FLIP library off the scaled canvas, and on the flow surfaces', () => {
    expect(source('src/client/TasksGraph.tsx')).not.toContain('use-auto-animate')
    expect(source('src/client/TasksTree.tsx')).toContain('useAutoAnimateRef')
    expect(source('src/client/JobsDrawer.tsx')).toContain('useAutoAnimateRef')
  })

  it('gives canvas cards a mount-only CSS entrance that respects reduced motion', () => {
    const styles = source('src/client/tasks-graph.module.css')
    const node = /\.node \{([\s\S]*?)\n\}/.exec(styles)?.[1]
    if (node === undefined) throw new Error('the .node rule must exist')
    expect(node).toContain('animation: dsh-card-in')
    const frames = /@keyframes dsh-card-in \{([\s\S]*?)\n\}/.exec(styles)?.[1]
    if (frames === undefined) throw new Error('the card entrance keyframes must exist')
    expect(frames).toContain('opacity: 0')
    // Every reduced-motion block in the sheet is a candidate — the sweep has
    // its own — and the card entrance must be switched off in one of them.
    const reduced = [...styles.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
      .map(match => match[1])
      .join('\n')
    expect(reduced).toContain('.node')
  })

  it('parks the motion host behind a WAAPI guard so tests and old hosts stay inert', () => {
    const hook = source('src/client/use-auto-animate.ts')
    expect(hook).toContain("typeof Element.prototype.animate === 'function'")
  })
})
