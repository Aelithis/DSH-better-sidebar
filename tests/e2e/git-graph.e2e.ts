import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sendFirstMessage, sidebarApi } from './host'

// A dedicated fixture: never initialize or write the caller's working repository.
test('read-only Git Graph renders merge history and filters without checkout', async ({ page }, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'sidebar-graph-e2e-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Graph fixture')
  git('config', 'user.email', 'graph@example.invalid')
  writeFileSync(join(root, 'base.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'Graph base')
  git('checkout', '-b', 'feature')
  writeFileSync(join(root, 'feature.txt'), 'feature\n')
  git('add', '.')
  git('commit', '-m', 'Graph feature')
  git('checkout', 'main')
  writeFileSync(join(root, 'main.txt'), 'main\n')
  git('add', '.')
  git('commit', '-m', 'Graph main')
  git('merge', '--no-ff', 'feature', '-m', 'Graph merge')
  const before = { head: git('rev-parse', 'HEAD'), refs: git('show-ref'), status: git('status', '--porcelain') }
  const api = await createHostApi()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
    const session = await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
    const response = await api.post(sidebarApi('git.graph'), { data: { sessionId: session.value.sessionId, cwd: root } })
    expect(response.ok()).toBe(true)
    await gotoPage(page)
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await dismissOnboarding(page)
    await sendFirstMessage(page)
    await page.locator('[data-sidebar-right-expand]').first().click()
    await page.locator('[data-sidebar-right-guide-entry="git"]').click()
    // The Graph area is a SECTION of the Git lens (#969's engine rendered in
    // #944's Source Control structure), unfolded by default: unfold it when a
    // previous run left it folded rather than toggling it shut.
    const graphHeader = page.getByRole('button', { name: 'Graph', exact: true }).first()
    if (await graphHeader.getAttribute('aria-expanded') !== 'true') await graphHeader.click()
    const graph = page.locator('[data-git-graph]:visible')
    await expect(graph.getByText('Graph merge', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
    await expect(graph.getByText('Graph feature', { exact: true }).first()).toBeVisible()
    await graph.getByText('Graph merge', { exact: true }).first().click()
    // The selection opens the DETAILS card in the shared bottom pane: the full
    // hash chip, both merge parents (7-char chips), and no first-parent note.
    // Scope to the card — short hashes also appear in the (hidden) Git lens.
    const panel = page.locator('[data-sidebar-right-panel]:visible')
    const card = panel.locator('section[aria-label]')
    await expect(card.getByText(before.head, { exact: true })).toBeVisible()
    const parents = git('rev-parse', 'HEAD^1', 'HEAD^2').split('\n')
    await expect(card.getByText(parents[0]!.slice(0, 7), { exact: true }).first()).toBeVisible()
    await expect(card.getByText(parents[1]!.slice(0, 7), { exact: true }).first()).toBeVisible()
    await expect(panel.getByText(/first parent/i)).toHaveCount(0)
    // The current branch's pill (HEAD folds into it) sits on the merge row.
    // Scoped to the row: the bare name also lives in the branch select.
    const mergeRow = graph.locator('[data-graph-commit]', { hasText: 'Graph merge' }).first()
    await expect(mergeRow.getByText('main', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('git-graph.png'), fullPage: true })
    const branchFilter = page.locator('[data-git-graph] select').filter({ has: page.locator('option[value="refs/heads/feature"]') })
    await branchFilter.selectOption('refs/heads/feature')
    await expect(graph.getByText('Graph merge', { exact: true })).toHaveCount(0)
    await expect(graph.getByText('Graph feature', { exact: true }).first()).toBeVisible()
    expect(errors).toEqual([])
    expect({ head: git('rev-parse', 'HEAD'), refs: git('show-ref'), status: git('status', '--porcelain') }).toEqual(before)
  } finally {
    await api.dispose()
    // Fixture retained with test artifacts for inspecting failures; no shared-path cleanup.
  }
})
