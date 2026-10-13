/**
 * The unified changes tab shell: the 36px header's lens switcher swaps the
 * Git lens for the session lens, a Git-lens file row opens the shared preview
 * pane (loaded through the mocked git API, rendered by the shared DiffFiles
 * stack), and the session ops ride the mocked `changes.ops` poll — the event
 * poll, the op fold and the badge cache all live in the tab.
 *
 * The copy assertions below pin the zh strings (the test environment's
 * navigator may be a real Node one with an en locale), so a bare substring
 * check cannot accidentally pass on a different message.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ChangesTab, opCountOf } from '../src/client/changes/ChangesTab.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitStatusEntry, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'

/** One synthetic tool/call + tool/result pair (write of one file). */
function writeEvents(seq: number, path: string): Array<{ type: string; seq: number; time: number; data: Record<string, unknown> }> {
  return [
    { type: 'tool/call', seq, time: seq, data: { name: 'write', callId: `w${seq}`, arguments: JSON.stringify({ file_path: path, content: 'body' }) } },
    { type: 'tool/result', seq: seq + 1, time: seq + 1, data: { message: { source: { kind: 'tool', callId: `w${seq}` }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
  ]
}

function fakeContext(): Context {
  return {
    get: () => undefined,
  } as unknown as Context
}

function mount(root: Root, tab: SidebarTab = { id: 'git', type: 'git', title: 'Changes' }): void {
  act(() => {
    root.render(createElement(ChangesTab, {
      ctx: fakeContext(),
      store: createSidebarStore(),
      scope: { sessionId: 'session', cwd: MAIN },
      tab,
      visible: true,
      onOpenFile: () => {},
      onOpenDiff: () => {},
    }))
  })
}

function mockGit(entries: GitStatusEntry[]): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
    { path: MAIN, branch: 'main', current: true, changes: entries.length },
  ] as GitWorktree[])
  vi.spyOn(api, 'gitStatus').mockResolvedValue({
    isRepo: true, branch: 'main', entries,
  } as GitStatusResult)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitLog').mockResolvedValue([])
}

/** One lens tab of the header's segmented control. */
function lensTab(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(tab => tab.textContent === label)
}

async function flushEffects(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ChangesTab', () => {
  it('renders the git lens by default and previews a file row in the pane', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitDiff').mockResolvedValue({
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      // Git lens: the change reads as a TREE — the directory row owns the
      // path segment, the file row its own name, its porcelain letter and the
      // host's file artwork.
      const dir = container.querySelector<HTMLButtonElement>('button[data-dir="src"]')
      expect(dir).not.toBeNull()
      expect(dir!.getAttribute('aria-expanded')).toBe('true')
      const row = container.querySelector<HTMLButtonElement>('button[data-path="src/a.ts"]')
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain('a.ts')
      expect(row!.textContent).toContain('M')
      expect(row!.querySelector('svg')).not.toBeNull()

      // Clicking the row previews inline (no diff tab minted): the shared
      // renderer draws the added row.
      await act(async () => { row!.click() })
      await flushEffects()
      expect(container.textContent).toContain('new')

      // The preview survives a lens switch (it is a dock, not lens state).
      const sessionTab = lensTab(container, t('changesSessionLens'))
      expect(sessionTab).toBeDefined()
      await act(async () => { sessionTab!.click() })
      expect(container.textContent).toContain('src/a.ts')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  /**
   * Issue #131, appearance half: a pure rename is `0 0` in numstat, so its row
   * prints no numbers — and a group whose ONLY changes are renames used to
   * render an empty `+N −M` cluster in its header, because the total counted
   * the (numberless) rename row as a contributor. The contrast case is the
   * other half of the gate: with one row that really has numbers, the cluster
   * is back and carries exactly those numbers.
   */
  it('renders no count cluster for a group whose only changes are pure renames (#131)', async () => {
    mockGit([
      { path: 'renamed.ts', xy: 'R ', counts: { additions: 0, deletions: 0 } },
      { path: 'moved.md', xy: ' R', counts: { additions: 0, deletions: 0 } },
    ])

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const staged = container.querySelector<HTMLElement>('[data-group="staged"]')
      const unstaged = container.querySelector<HTMLElement>('[data-group="unstaged"]')
      // Both groups really rendered their rename row, so the absence asserted
      // below is the counts cluster's, not the whole group's.
      expect(staged!.querySelectorAll('button[data-path]')).toHaveLength(1)
      expect(unstaged!.querySelectorAll('button[data-path]')).toHaveLength(1)
      expect(staged!.querySelector('[data-lines="group"]')).toBeNull()
      expect(unstaged!.querySelector('[data-lines="group"]')).toBeNull()
      // The renames are still listed with their count pill (the FILE count).
      expect(staged!.querySelector('[data-count]')!.textContent).toBe('1')
      expect(unstaged!.querySelector('[data-count]')!.textContent).toBe('1')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps the group total when a row in the group really has numbers (#131)', async () => {
    mockGit([
      { path: 'mode-only.ts', xy: ' M', counts: { additions: 0, deletions: 0 } },
      { path: 'edited.ts', xy: ' M', counts: { additions: 3, deletions: 1 } },
    ])

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const unstaged = container.querySelector<HTMLElement>('[data-group="unstaged"]')
      const cluster = unstaged!.querySelector<HTMLElement>('[data-lines="group"]')
      expect(cluster).not.toBeNull()
      expect(cluster!.getAttribute('data-added')).toBe('3')
      expect(cluster!.getAttribute('data-deleted')).toBe('1')
      expect(cluster!.textContent).toContain('+3')
      // The cluster is not merely present — it carries text (an EMPTY cluster
      // is exactly the artifact this pair of cases is about).
      expect(cluster!.textContent).not.toBe('')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('sizes the count cluster from a font token, never from a bare px (#131)', () => {
    // Skin contract (guide §12): visual values ride `--dsw-font-*` / `--ds-*`
    // tokens. The row/band cluster is the one place in this sheet that used a
    // literal `font-size: 10px`, two pixels off the smallest host token.
    const sheet = readFileSync('src/client/changes/changes.module.css', 'utf8')
    const block = sheet.match(/\n\.lineCounts \{([\s\S]*?)\n\}/)?.[1]
    expect(block, 'the .lineCounts rule must exist in changes.module.css').toBeDefined()
    expect(block!).toContain('font: var(--dsw-font-')
    expect(block!).toContain('font-family: var(--ds-font-family-code')
    expect(block!).not.toMatch(/font-size:\s*[\d.]+px/)
  })

  it('folds the polled session events into session-lens rows and the badge cache', async () => {
    mockGit([])
    const ops = vi.spyOn(api, 'changesOps')
      .mockResolvedValue({ events: [...writeEvents(1, 'src/a.ts'), ...writeEvents(3, 'src/b.ts')], lastSeq: 4 })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      // Opening the tab pulls once and publishes the op count (the tab-strip
      // badge reads this cache).
      expect(ops).toHaveBeenCalled()
      expect(opCountOf('session')).toBe(2)

      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })
      // Two files grouped, newest first; the write chip carries its count.
      expect(container.textContent).toContain('src/b.ts')
      expect(container.textContent).toContain('src/a.ts')
      const chips = [...container.querySelectorAll('button[aria-pressed]')]
      expect(chips.some(chip => /写入\s*2|Write\s*2/.test(chip.textContent ?? ''))).toBe(true)
      // The Git lens (including its footer branch menu) is unmounted by the switch.
      expect(container.querySelector('[data-git-root]')).toBeNull()
      expect(container.querySelector('[data-git-footer]')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders a .md read op in reading mode through the shared MarkdownText', async () => {
    mockGit([])
    const md = ['# Title', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', '![pic](./img.png)', ''].join('\n')
    const numbered = md.split('\n').map((line, i) => String(i + 1) + ': ' + line).join('\n')
    const envelope = '<content>\n' + numbered + '\n</content>'
    vi.spyOn(api, 'changesOps').mockResolvedValue({
      events: [
        { type: 'tool/call', seq: 1, time: 1, data: { name: 'read', callId: 'r1', arguments: JSON.stringify({ file_path: 'C:/repo/main/notes.md' }) } },
        { type: 'tool/result', seq: 2, time: 2, data: { message: { source: { kind: 'tool', callId: 'r1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: envelope }] }] } } },
      ],
      lastSeq: 2,
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      // Session lens: open the read op's preview.
      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })
      const row = container.querySelector<HTMLButtonElement>('button[data-op-kind="read"]')
      expect(row).toBeDefined()
      expect(container.textContent).toContain('notes.md')
      await act(async () => { row!.click() })
      await flushEffects()

      // Reading toggle: raw first (line-numbered rows), then rendered GFM.
      const toggle = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => (button.textContent ?? '').match(/阅读|Reading/))
      expect(toggle).toBeDefined()
      expect(container.querySelector('h1')).toBeNull()
      await act(async () => { toggle!.click() })
      await flushEffects()
      expect(container.querySelector('h1')?.textContent).toContain('Title')
      expect(container.querySelector('table')).not.toBeNull()
      // The local image destination was rewritten to the media route.
      const img = container.querySelector('img')
      expect(img?.getAttribute('src')).toContain('/sidebar/file?')
      // Toggling back restores the raw line view.
      const rawToggle = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => (button.textContent ?? '').match(/原文|Raw/))
      await act(async () => { rawToggle!.click() })
      await flushEffects()
      expect(container.querySelector('h1')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders exactly one clean empty state, and the history has its own', async () => {
    mockGit([])

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      // A clean repository says it ONCE: both sections (unstaged/staged) used
      // to print their own "no changes" line under the same message.
      const empties = [...container.querySelectorAll<HTMLElement>('[data-kind="empty"]')]
        .map(node => node.textContent)
      expect(empties).toEqual([t('changesClean'), t('changesNoHistory')])
      // No resource group or tree row is rendered when nothing changed.
      expect(container.querySelectorAll('[data-group]')).toHaveLength(0)
      expect(container.querySelectorAll('[data-path]')).toHaveLength(0)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('reports a failed stage action in the footer and catches it (no unhandled rejection)', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitStage').mockRejectedValue(new Error('index.lock exists'))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const stage = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('stage')}"]`)
      expect(stage).not.toBeNull()
      await act(async () => { stage!.click() })
      await flushEffects()

      const alerts = [...container.querySelectorAll<HTMLElement>('[role="alert"]')]
      const alert = alerts.find(node => (node.textContent ?? '').includes(t('changesStageFailed', { message: 'index.lock exists' })))
      expect(alert).toBeDefined()
      expect(alerts).toHaveLength(1)
      // The ONE action status line stays visible with the checkout/sync footer.
      const footer = container.querySelector('[data-git-footer]')
      const input = container.querySelector('[data-message-box] textarea')
      expect(input).not.toBeNull()
      expect(alert!.parentElement).toBe(footer)
      expect(alert!.nextElementSibling).toBe(footer!.querySelector('[data-footer-row]'))
      expect(container.querySelector('[data-git-scroll]')!.contains(alert!)).toBe(false)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps Git refresh in Changes and re-derives the session preview on manual refresh', async () => {
    mockGit([])
    const ops = vi.spyOn(api, 'changesOps')
      // The call starts running: no result yet, so the write has no payload.
      .mockResolvedValueOnce({
        events: [{ type: 'tool/call', seq: 1, time: 1, data: { name: 'write', callId: 'w1', arguments: JSON.stringify({ file_path: 'notes.txt' }) } }],
        lastSeq: 1,
      })
      // The result lands in a later delta and settles the same callId.
      .mockResolvedValueOnce({
        events: [{ type: 'tool/result', seq: 2, time: 2, data: { message: { source: { kind: 'tool', callId: 'w1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'settled-body' }] }] } } }],
        lastSeq: 2,
      })
      .mockResolvedValue({ events: [], lastSeq: 2 })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      const refreshSelector = `button[aria-label="${t('refresh')}"]`
      const head = container.querySelector('[role="tablist"]')!.parentElement!
      // Git has one refresh, inside Changes rather than beside the lens tabs.
      expect(head.querySelector(refreshSelector)).toBeNull()
      expect(container.querySelectorAll(refreshSelector)).toHaveLength(1)
      expect(container.querySelector(`[data-scm-section="changes"] ${refreshSelector}`)).not.toBeNull()
      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })

      const row = container.querySelector<HTMLButtonElement>('button[data-op-kind="write"]')
      expect(row).toBeDefined()
      await act(async () => { row!.click() })
      await flushEffects()
      expect(container.textContent).toContain(t('changesPriorUnknown'))
      expect(container.textContent).not.toContain('settled-body')

      // The header's refresh pulls the delta; the SAME preview must pick the
      // settled payload up without the user re-clicking the row.
      const refresh = head.querySelector<HTMLButtonElement>(refreshSelector)
      expect(refresh).not.toBeNull()
      expect(container.querySelectorAll(refreshSelector)).toHaveLength(1)
      expect(ops).toHaveBeenCalledTimes(1)
      await act(async () => { refresh!.click() })
      await flushEffects()
      expect(ops).toHaveBeenLastCalledWith({ sessionId: 'session', cwd: MAIN }, 1, undefined)
      expect(container.textContent).toContain('settled-body')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('shows a history failure instead of claiming there are no commits', async () => {
    mockGit([])
    vi.spyOn(api, 'gitLog').mockRejectedValue(new Error('bad object'))

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      expect(container.textContent).toContain(t('historyLoadError'))
      expect(container.textContent).not.toContain(t('changesNoHistory'))
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps the preview redaction toggle working (a secret file masks by default)', async () => {
    mockGit([])
    localStorage.removeItem('dsh-sidebar:v1:redaction')
    vi.spyOn(api, 'changesOps').mockResolvedValue({
      events: [
        { type: 'tool/call', seq: 1, time: 1, data: { name: 'read', callId: 'r1', arguments: JSON.stringify({ file_path: 'C:/repo/main/.env' }) } },
        { type: 'tool/result', seq: 2, time: 2, data: { message: { source: { kind: 'tool', callId: 'r1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '<content>1: OPENAI_API_KEY=sk-abcdefghijklmnop</content>' }] }] } } },
      ],
      lastSeq: 2,
    })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })
      const row = container.querySelector<HTMLButtonElement>('button[data-op-kind="read"]')
      await act(async () => { row!.click() })
      await flushEffects()

      // Redaction is on by default: the secret never reaches the DOM.
      expect(container.textContent).toContain('[REDACTED]')
      expect(container.textContent).not.toContain('sk-abcdefghijklmnop')

      // The kit toggle (a Chip) turns it off, and only then does the raw value
      // render; toggling back masks it again.
      const byLabel = (label: string): HTMLButtonElement | undefined =>
        [...container.querySelectorAll<HTMLButtonElement>('button')]
          .find(button => (button.textContent ?? '') === label)
      const on = byLabel(t('changesRedactOnLabel'))
      expect(on).toBeDefined()
      await act(async () => { on!.click() })
      await flushEffects()
      expect(container.textContent).toContain('sk-abcdefghijklmnop')
      const off = byLabel(t('changesRedactOffLabel'))
      expect(off).toBeDefined()
      await act(async () => { off!.click() })
      await flushEffects()
      expect(container.textContent).not.toContain('sk-abcdefghijklmnop')
    } finally {
      act(() => { root.unmount() })
      container.remove()
      localStorage.removeItem('dsh-sidebar:v1:redaction')
    }
  })

  it('clamps the restored preview height to the pane bounds', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitDiff').mockResolvedValue({
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    })

    /** Open the pane with one persisted height and read back the rendered one. */
    const paneHeightFor = async (previewH: number): Promise<string | undefined> => {
      const container = document.createElement('div')
      document.body.append(container)
      const root: Root = createRoot(container)
      try {
        mount(root, { id: 'git', type: 'git', title: 'Changes', meta: { previewH } })
        await flushEffects()
        const row = container.querySelector<HTMLButtonElement>('button[data-path="src/a.ts"]')
        expect(row).not.toBeNull()
        await act(async () => { row!.click() })
        await flushEffects()
        return container.querySelector<HTMLElement>('[role="separator"]')?.parentElement?.style.height
      } finally {
        act(() => { root.unmount() })
        container.remove()
      }
    }

    // A height saved under a taller window cannot open past the pane's cap...
    expect(await paneHeightFor(5000)).toBe(`${String(Math.round(window.innerHeight * 0.7))}px`)
    // ...and an unusably small one is raised to the content minimum.
    expect(await paneHeightFor(50)).toBe('140px')
  })

  /**
   * Issue #194's single-scroller frame survives #941: Message, groups and Graph
   * now scroll together, while the checkout/sync footer stays docked outside.
   * The old selector band and bottom commit bar are intentionally gone.
   */
  it('scrolls Message, change groups and Graph together with the footer outside (#194, #941)', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitLog').mockResolvedValue([{
      hash: 'abcdef0',
      hashFull: 'abcdef0abcdef0abcdef0abcdef0abcdef0abcd',
      parents: [],
      subject: 'history row',
      author: 'Test',
      date: '2026-08-20 00:00:00 +0800',
      refs: 'HEAD -> main',
    }])

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()

      const frame = container.querySelector<HTMLElement>('[data-git-root]')
      const scroller = container.querySelector<HTMLElement>('[data-git-scroll]')
      const footer = container.querySelector<HTMLElement>('[data-git-footer]')
      expect(frame).not.toBeNull()
      expect(scroller).not.toBeNull()
      expect(footer).not.toBeNull()
      expect(frame!.hasAttribute('data-git-scroll')).toBe(false)
      expect(container.querySelectorAll('[data-git-scroll]')).toHaveLength(1)
      expect(scroller!.parentElement).toBe(frame)
      expect(footer!.parentElement).toBe(frame)
      expect(scroller!.contains(footer!)).toBe(false)
      expect(scroller!.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(footer!.querySelector('[data-footer-row] button[aria-haspopup="menu"]')).not.toBeNull()
      expect(container.querySelector('[data-git-head]')).toBeNull()
      expect(container.querySelector('[data-commit-bar]')).toBeNull()
      expect(container.querySelector('select')).toBeNull()

      const changes = scroller!.querySelector('[data-scm-section="changes"]')
      const graph = scroller!.querySelector('[data-scm-section="graph"]')
      const message = changes!.querySelector('[data-message-box]')
      const unstaged = changes!.querySelector('[data-group="unstaged"]')
      expect(message!.querySelector('textarea')).not.toBeNull()
      expect(unstaged!.querySelector('[data-path="src/a.ts"]')).not.toBeNull()
      expect(changes!.querySelector('[data-group="staged"]')).toBeNull()
      expect(message!.compareDocumentPosition(unstaged!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(changes!.compareDocumentPosition(graph!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const historyRow = graph!.querySelector<HTMLElement>('[data-graph-row]')
      expect(historyRow).not.toBeNull()
      expect(historyRow!.textContent).toContain('history row')
      expect(footer!.querySelector('textarea')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps one inner scroller and pins the footer to the bottom (#194, #941)', () => {
    // jsdom has no layout engine, so the sheet itself is the docking evidence.
    const sheet = readFileSync('src/client/changes/changes.module.css', 'utf8')
    const rule = (selector: string): string => {
      const block = sheet.match(new RegExp(`\\n\\${selector} \\{([^}]+)\\}`))?.[1]
      expect(block, `the ${selector} rule must exist in changes.module.css`).toBeDefined()
      return block!
    }

    expect(rule('.git')).not.toContain('overflow')
    expect(rule('.git')).toContain('display: flex')
    expect(rule('.gitScroll')).toContain('overflow-y: auto')
    expect(rule('.gitScroll')).toContain('overflow-x: hidden')
    expect(rule('.gitScroll')).toContain('flex: 1')
    // Docked by flex, and sticky so a host-scrolled tab body cannot carry the
    // branch control off the bottom of the pane either.
    expect(rule('.gitFooter')).toContain('flex: none')
    expect(rule('.gitFooter')).toContain('position: sticky')
    expect(rule('.gitFooter')).toContain('bottom: 0')
    expect(rule('.gitFooter')).not.toContain('overflow')
    expect(rule('.messageBox')).not.toMatch(/position|sticky|overflow/)
    expect(sheet).not.toMatch(/\.(?:selectors|select|branchLabel|commitBar|commitRow)\s*\{/)
    // The retained group headers still park on the inner body's top edge.
    const groupHeader = rule('.group .groupHeader')
    expect(groupHeader).toContain('position: sticky')
    expect(groupHeader).toContain('top: 0')
  })

  it('polls the session events only while the session lens is on screen', async () => {
    vi.useFakeTimers()
    mockGit([])
    const ops = vi.spyOn(api, 'changesOps').mockResolvedValue({ events: [], lastSeq: 0 })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      mount(root)
      await flushEffects()
      // Opening the tab is one catch-up pull (the badge count follows it).
      expect(ops).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      // The git lens has no use for the session event log: no cadence at all.
      expect(ops).toHaveBeenCalledTimes(1)

      const sessionTab = lensTab(container, t('changesSessionLens'))
      await act(async () => { sessionTab!.click() })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      // On screen: the 2.5s delta cadence runs.
      expect(ops.mock.calls.length).toBeGreaterThan(1)
    } finally {
      act(() => { root.unmount() })
      container.remove()
      vi.useRealTimers()
    }
  })
})
