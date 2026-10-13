/** @vitest-environment jsdom */
import { act } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type GitStatusResult, type SessionScope } from '../src/client/api.ts'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { invalidateGitStatus } from '../src/client/ui/git-status.ts'
import { t } from '../src/client/locales.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
afterEach(() => { vi.restoreAllMocks() })
const CWD = 'C:/repo'
const store = createSidebarStore()
const tracked = (): GitStatusResult => ({
  isRepo: true, branch: 'main', root: CWD, upstream: 'origin/main', ahead: 1, behind: 0,
  entries: [{ path: 'src/partial.ts', xy: 'MD' }, { path: 'new.ts', xy: '??' }],
})
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
const click = async (button: HTMLButtonElement): Promise<void> => { await act(async () => { button.click() }) }
const input = (container: HTMLElement): HTMLTextAreaElement => container.querySelector<HTMLTextAreaElement>('[data-message-box] textarea')!
const write = async (box: HTMLTextAreaElement, value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const enter = async (box: HTMLTextAreaElement): Promise<void> => {
  await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })) })
}
async function mount(readStatus: (scope: SessionScope) => GitStatusResult) {
  vi.spyOn(api, 'gitStatus').mockImplementation(async scope => readStatus(scope))
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: CWD, branch: 'main', current: true, changes: 2 }])
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main', 'feature'] })
  vi.spyOn(api, 'gitCommitModel').mockResolvedValue({ pinned: false })
  vi.spyOn(api, 'gitLog').mockResolvedValue([{ hash: 'abc1234', hashFull: 'a'.repeat(40), parents: [], subject: 'Initial', author: 'Ada', date: '2026-10-13', refs: 'HEAD -> main' }])
  const render = (sessionId: string) => <GitLens scope={{ sessionId, cwd: CWD }} store={store} visible
    selectedRef={null} onOpenFile={() => {}} onPreview={() => {}} />
  const view = renderRoot(render('scm-A'))
  await flush()
  await flush()
  return { ...view, switchTo: async (session: string) => { view.rerender(render(session)); await flush(); await flush() } }
}

it('orders distinct conflict/index/worktree groups, folds independently, and keeps the footer', async () => {
  const snapshot = { ...tracked(), operation: 'merge' as const, entries: [...tracked().entries, { path: 'conflict.ts', xy: 'UU' }] }
  const view = await mount(() => snapshot)
  const stage = vi.spyOn(api, 'gitStage').mockResolvedValue({ ok: true })
  try {
    const { container } = view
    expect([...container.querySelectorAll<HTMLElement>('[data-group]')].map(el => el.dataset.group)).toEqual(['merge', 'staged', 'unstaged'])
    expect([...container.querySelectorAll('[data-group] > header [data-count], [data-group] > div:first-child [data-count]')].map(el => el.textContent)).toEqual(['1', '1', '2'])
    expect(container.querySelector('[data-group="staged"] [data-path="src/partial.ts"] [data-tone]')!.textContent).toBe('M')
    expect(container.querySelector('[data-group="unstaged"] [data-path="src/partial.ts"] [data-tone]')!.textContent).toBe('D')
    const footer = container.querySelector('[data-git-footer]')!
    expect(footer.textContent).toContain('main*+!')
    expect(container.querySelector('[data-git-scroll]')!.contains(footer)).toBe(false)
    const changes = container.querySelector<HTMLButtonElement>('[data-scm-section="changes"] button[aria-expanded]')!
    const graph = container.querySelector<HTMLButtonElement>('[data-scm-section="graph"] button[aria-expanded]')!
    await write(input(container), 'kept draft')
    await click(changes)
    expect(input(container)).toBeNull()
    expect(container.querySelector('[data-graph-row]')).not.toBeNull()
    await click(graph)
    expect(container.querySelector('[data-graph-row]')).toBeNull()
    expect(footer.querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
    await click(changes)
    expect(input(container).value).toBe('kept draft')
    await click(container.querySelector<HTMLButtonElement>(`[data-group="unstaged"] button[aria-label="${t('stageAll')}"]`)!)
    expect(stage.mock.calls.map(call => call[1])).toEqual(['src/partial.ts', 'new.ts'])
    expect(changes.getAttribute('aria-expanded')).toBe('true')
  } finally { view.unmount() }
})

it('applies the same commit guard to keyboard and button, without auto-staging', async () => {
  let snapshot = { ...tracked(), entries: [{ path: 'new.ts', xy: '??' }] }
  const commit = vi.spyOn(api, 'gitCommit').mockResolvedValue({ ok: true })
  const stage = vi.spyOn(api, 'gitStage').mockResolvedValue({ ok: true })
  const view = await mount(() => snapshot)
  const refresh = async () => { await act(async () => { invalidateGitStatus('scm-A') }); await flush() }
  try {
    await write(input(view.container), 'feat: multiline\n\nbody')
    await enter(input(view.container))
    expect(commit).not.toHaveBeenCalled()
    snapshot = { ...tracked(), entries: [{ path: 'ready.ts', xy: 'M ' }, { path: 'conflict.ts', xy: 'UU' }] }
    await refresh()
    await enter(input(view.container))
    expect(commit).not.toHaveBeenCalled()
    snapshot = { ...tracked(), entries: [{ path: 'ready.ts', xy: 'M ' }] }
    await refresh()
    await write(input(view.container), '  ')
    await enter(input(view.container))
    expect(commit).not.toHaveBeenCalled()
    await write(input(view.container), 'feat: multiline\n\nbody')
    await enter(input(view.container))
    expect(commit).toHaveBeenCalledExactlyOnceWith({ sessionId: 'scm-A', cwd: CWD }, 'feat: multiline\n\nbody', CWD)
    expect(stage).not.toHaveBeenCalled()
  } finally { view.unmount() }
})

it('isolates late generation, failure and busy state across scopes, while preserving drafts', async () => {
  let resolveA!: (value: { message: string; provider: string; model: string }) => void
  let resolveB!: (value: { message: string; provider: string; model: string }) => void
  const suggest = vi.spyOn(api, 'gitSuggestMessage')
    .mockReturnValueOnce(new Promise(resolve => { resolveA = resolve }))
    .mockReturnValueOnce(new Promise(resolve => { resolveB = resolve }))
    .mockRejectedValueOnce(new Error('temporary outage'))
    .mockResolvedValueOnce({ message: 'retry draft', provider: 'test', model: 'test' })
  const commit = vi.spyOn(api, 'gitCommit').mockResolvedValue({ ok: true })
  const view = await mount(() => tracked())
  const generate = (): HTMLButtonElement => view.container.querySelector<HTMLButtonElement>('button[aria-label^="Generate commit message"]')!
  try {
    await write(input(view.container), 'A draft')
    await click(generate())
    expect(input(view.container).disabled).toBe(true)
    await view.switchTo('scm-B')
    expect(input(view.container).disabled).toBe(false)
    await write(input(view.container), 'B draft')
    await click(generate())
    await act(async () => { resolveA({ message: 'late A', provider: 'test', model: 'test' }); await Promise.resolve() })
    expect(input(view.container).value).toBe('B draft')
    expect(input(view.container).disabled).toBe(true)
    await act(async () => { resolveB({ message: 'generated B', provider: 'test', model: 'test' }); await Promise.resolve() })
    expect(input(view.container).value).toBe('generated B')
    expect(commit).not.toHaveBeenCalled()
    await view.switchTo('scm-A')
    expect(input(view.container).value).toBe('A draft')
    await click(generate())
    expect(view.container.textContent).toContain('temporary outage')
    await click(generate())
    expect(input(view.container).value).toBe('retry draft')
    expect(view.container.textContent).not.toContain('temporary outage')
    expect(suggest).toHaveBeenCalledTimes(4)
  } finally { view.unmount() }
})

it('shows genuine upstream counts, syncs Pull then Push, and never pushes after a failed Pull', async () => {
  let snapshot = tracked()
  const order: string[] = []
  const pull = vi.spyOn(api, 'gitPull').mockImplementation(async () => { order.push('pull'); return { ok: true } })
  const push = vi.spyOn(api, 'gitPush').mockImplementation(async () => { order.push('push'); return { ok: true } })
  const view = await mount(() => snapshot)
  const sync = (): HTMLButtonElement => view.container.querySelector<HTMLButtonElement>(`[data-git-footer] button[aria-label^="${t('gitSync')}"]`)!
  try {
    expect(sync().textContent).toContain('0↓ 1↑')
    expect(sync().title).toContain('origin/main')
    await click(sync())
    expect(order).toEqual(['pull', 'push'])
    pull.mockRejectedValueOnce(new Error('diverged'))
    await click(sync())
    expect(push).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).toContain('diverged')
    snapshot = { ...tracked(), ahead: 2, behind: 3 }
    await act(async () => { invalidateGitStatus('scm-A') }); await flush()
    expect(sync().textContent).toContain('3↓ 2↑')
    const statusCalls = vi.mocked(api.gitStatus).mock.calls.length
    push.mockRejectedValueOnce(new Error('push denied'))
    await click(sync())
    expect(view.container.textContent).toContain('push denied')
    expect(vi.mocked(api.gitStatus).mock.calls.length).toBeGreaterThan(statusCalls)
    snapshot = { ...tracked(), upstream: undefined, ahead: undefined, behind: undefined }
    await act(async () => { invalidateGitStatus('scm-A') }); await flush()
    expect(view.container.querySelector<HTMLButtonElement>('[data-git-footer] button[aria-label="No upstream"]')!.disabled).toBe(true)
    snapshot = { ...snapshot, branch: '', detached: true }
    await act(async () => { invalidateGitStatus('scm-A') }); await flush()
    expect(view.container.querySelector<HTMLButtonElement>('[data-git-footer] button[aria-label="Detached HEAD"]')!.disabled).toBe(true)
  } finally { view.unmount() }
})

it('checks out a plain branch and refreshes placeholder, resources, graph and footer together', async () => {
  let snapshot = tracked()
  const checkout = vi.spyOn(api, 'gitCheckout').mockImplementation(async (_scope, branch) => {
    snapshot = { ...tracked(), branch, entries: [], ahead: 0, behind: 2, upstream: 'origin/feature' }
    return { ok: true }
  })
  const view = await mount(() => snapshot)
  try {
    expect(input(view.container).placeholder).toBe('Message (Ctrl+Enter to commit on "main")')
    const logCalls = vi.mocked(api.gitLog).mock.calls.length
    await click(view.container.querySelector<HTMLButtonElement>('[data-git-footer] button[aria-haspopup="menu"]')!)
    const feature = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'feature')!
    await click(feature)
    await flush()
    expect(checkout).toHaveBeenCalledExactlyOnceWith({ sessionId: 'scm-A', cwd: CWD }, 'feature', CWD)
    expect(input(view.container).placeholder).toBe('Message (Ctrl+Enter to commit on "feature")')
    expect(view.container.querySelectorAll('[data-group]')).toHaveLength(0)
    expect(view.container.querySelector('[data-git-footer]')!.textContent).toContain('2↓ 0↑')
    expect(vi.mocked(api.gitLog).mock.calls.length).toBeGreaterThan(logCalls)
  } finally { view.unmount() }
})
