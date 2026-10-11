/**
 * Over-limit reads: a file above the editable threshold (`MAX_EDITABLE_BYTES`)
 * is never handed to a viewer as a document. The viewer that owns its
 * extension still renders, but as the read-only paged preview — so the pane
 * carries the too-large notice and a download link, and there is NO editor at
 * all: no CodeMirror instance and no save surface. This replaces the retired
 * #732 premise (a capped read rendered a read-only editor over a prefix of the
 * file): the host refuses the document instead of handing over a prefix, so
 * "save the prefix back over the file" is not a state that can exist any more
 * (see src/editor-limits.ts).
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { downloadUrl } from '../src/client/api.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { attachLocale, t } from '../src/client/locales.ts'
import { formatByteSize, MAX_EDITABLE_LABEL } from '../src/editor-limits.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { FileViewerProps } from '../src/client/service.ts'

setupReactAct()

/** The paged preview's reads; `api.fsReadPage` is the only route it uses. */
const readPage = vi.fn()
// Partial mock: the paged preview reads through `api.fsReadPage` on mount, and
// `downloadUrl` (the notice's link) must stay the real implementation.
vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      fsReadPage: (...args: unknown[]) => readPage(...args),
      // The code viewer's git gutter polls the shared status store; a
      // non-repo answer keeps the editor mount off the network.
      gitStatus: async () => ({ isRepo: false, entries: [] }),
    },
  }
})

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
  register(_ns: string, _locale: string, _dict: Record<string, string>): () => void {
    return () => {}
  }
}

const CTX = {} as Context
const SCOPE = { sessionId: 's1', cwd: '/p' }
const PATH = '/p/big.txt'
/** Above MAX_EDITABLE_BYTES (5 MiB): the host answers `too-large`. */
const SIZE = 6 * 1024 * 1024
const PAGE = 'alpha\nbeta\n'

function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: CTX,
    store: createSidebarStore(),
    scope: SCOPE,
    path: PATH,
    title: 'big.txt',
    viewerId: 'code',
    ...overrides,
  }
}

/** Settle the pager's first read (mount effect → promise → state). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  attachLocale(undefined)
  readPage.mockReset()
})

describe('TextEditor over-limit preview', () => {
  it('renders the paged preview: notice + download link, no editor and no save', async () => {
    attachLocale(new FakeLocale())
    readPage.mockResolvedValue({
      kind: 'text', text: PAGE, offset: 0, nextOffset: SIZE, eof: true, size: SIZE, encoding: 'utf8',
    })
    // The load plan's shape for a `too-large` read: size + largeFile, and no
    // content (see planFsReadOutcome).
    const { container, unmount } = renderRoot(
      createElement(TextEditor, viewerProps({ size: SIZE, largeFile: { size: SIZE } })),
    )
    try {
      await flush()

      // (a) The notice names the file's size and the edit threshold.
      expect(container.textContent).toContain(
        t('previewOnlyNotice', { size: formatByteSize(SIZE), limit: MAX_EDITABLE_LABEL }),
      )
      // (b) The download link points at the raw-bytes route.
      const link = container.querySelector('a[download]')
      expect(link, 'the over-limit preview offers the download').not.toBeNull()
      expect(link!.getAttribute('href')).toBe(downloadUrl(SCOPE, PATH))
      expect(link!.textContent).toBe(t('downloadToView'))
      // (c) No editor is built at all: the component returns before the
      // CodeMirror host exists, which is what makes "no save" structural
      // rather than a hidden button.
      expect(container.querySelector('.cm-editor')).toBeNull()
      expect(container.querySelector('.cm-content')).toBeNull()
      expect(container.querySelector('button[aria-label="Save"]')).toBeNull()
      // The preview is live, not a placeholder: it paged the file from offset
      // 0 and renders the page it got back.
      expect(readPage).toHaveBeenCalledWith(expect.anything(), PATH, 0)
      expect(container.textContent).toContain('alpha')
    } finally {
      unmount()
    }
  })

  it('keeps the CodeMirror editor and its save button for an editable load', async () => {
    attachLocale(new FakeLocale())
    // (d) The contrast that gives the assertions above their meaning: the same
    // component, only without `largeFile`, mounts the editor and offers save.
    const { container, unmount } = renderRoot(
      createElement(TextEditor, viewerProps({ content: 'hello\n', size: 6 })),
    )
    try {
      expect(container.querySelector('.cm-editor')).not.toBeNull()
      expect(container.querySelector('button[aria-label="Save"]')).not.toBeNull()
      expect(readPage, 'an editable load never pages').not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })
})
