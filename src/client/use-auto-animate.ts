/**
 * The Tasks page's motion host: `@formkit/auto-animate` (FLIP) attached through
 * ONE guarded hook, so every animated container in the page behaves the same and
 * the test / non-WAAPI environments stay inert.
 *
 * What it buys: cards animate in and out when a group folds or expands, siblings
 * slide to their new slots, and a tree row / job row never pops. The library
 * needs `Element.prototype.animate` (Web Animations API — the plugin already
 * requires modern Chromium for the native sidebar) and a real layout pass, so
 * the hook attaches to nothing when either is missing: jsdom renders the same
 * DOM without motion, and no test has to stub an animation engine.
 *
 * The library respects `prefers-reduced-motion` on its own (its
 * `disrespectUserMotionPreference` option defaults to false), which is the same
 * contract the bar's sweep keeps in CSS.
 */
import autoAnimate from '@formkit/auto-animate'
import { useEffect, type RefObject } from 'react'

/** Whether this environment can run FLIP animations at all. */
function canAnimate(): boolean {
  return typeof Element !== 'undefined'
    && typeof Element.prototype.animate === 'function'
    && typeof document !== 'undefined'
}

/**
 * Animate one container's children.
 *
 * @param ref - the container whose DIRECT children are animated. Layout changes
 *   below the direct children (a card's own rows) are not animated — that is the
 *   library's own scope rule, and the page keeps one host per list it wants
 *   animated.
 */
export function useAutoAnimateRef<T extends HTMLElement>(ref: RefObject<T | null>): void {
  useEffect(() => {
    const element = ref.current
    if (element === null || !canAnimate()) return
    const controller = autoAnimate(element)
    return () => { controller.destroy?.() }
  }, [ref])
}
