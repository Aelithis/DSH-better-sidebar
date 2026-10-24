# 选区引用改气泡：把「添加到对话」从铺开正文改成 chip

**日期**：2026-10-24
**分支**：`feat/selection-chip-compact`（从 `dev` 切出）
**状态**：已实施，门禁见 §5

---

## 1. 背景

侧栏文本查看器（markdown 预览 + 兜底代码查看器）选中文字后点浮层的「添加到对话」，draft 里插进去的是一整段**围栏代码块**（info line = `相对路径:起止行`，正文 = 选中文字）。

单次引用没问题；连续引用几段就把输入框铺满，用户真正要写的那句话被挤没影了。DSH 自己的 `@file` 引用在同一个输入框里却是**一个紧凑气泡**（图标 + 文件名）。这次的诉求就是把这个反差抹平：**引用只要一个标识，正文交给模型**。

## 2. 机制（为什么插件侧就能做到）

宿主 composer 是 Lexical contenteditable，引用条目是 `ReferenceChipNode`。它有三个可以分开的字段：

| 字段 | 作用 |
|---|---|
| `label` | 气泡上显示的字 |
| `ref` | 发送时序列化给模型的正文（`source: 'reference'` 的 codec 是恒等） |
| `clipboardText` | 草稿串里占位的那段文本 |

所以「显示短、发送长」本来就是宿主支持的能力，插件只需按这个形状发插入请求。

插入通道复用文件树 `@` 按钮已经在用的 `slash/input-insert-reference`（`source: 'reference'`），不新增 source、不碰 `inputTriggers` 注册表。

## 3. 关键坑：两套坐标系

宿主对输入框维护两个投影：

| 投影 | 一个气泡占多长 | 谁在用 |
|---|---|---|
| clipboard（`InputState.draft`、`occurrences`） | 整个 `clipboardText` | 插件：读草稿串、算位置 |
| detect（`detectText`） | **1 个字符** `U+FFFC` | 宿主：所有插入事件的 `span` |

草稿为空时两套坐标重合，第一次插入成功；草稿里一旦有气泡，从草稿偏移直接算出的 `span` 必然越界，宿主拒绝（`applied = false`），**第二次插入静默失败**。

修复：`foldClipboardOffset` 按 `occurrences` 把草稿偏移折到 detect 偏移。唯一有意的偏离——偏移正好落在气泡**起点**时，返回气泡**之前**的位置（宿主自己的同名函数会把它读成「在气泡内部」而返回尾边）。

## 4. 改动

| 文件 | 变更 |
|---|---|
| `src/client/conversation-draft.ts` | 新增 `foldClipboardOffset`、`insertDraftReference`、`DraftReference` 类型；`insertFileReference` 改走同一函数（行为不变）；`appendToDraft` 在草稿已有气泡时改走 `slash/input-insert-text`，不再用 `setDraft` |
| `src/client/selection-payload.ts` | `buildSelectionInsert` 返回 `{ label, text }`（原返回单个字符串） |
| `src/client/selection-popup.ts` | 三个导出接口与 hook 泛型化，默认 `T = string`，字符串调用方零改动 |
| `src/client/TextEditor.tsx` | `useSelectionPopup<DraftReference>`；commit 先试气泡，失败回退纯文本 |
| `src/context-types.ts` | `SidebarSessionInput.state.getSnapshot()` 补 `occurrences` / `phase` |

**为什么 `appendToDraft` 也要改**：`setDraft` 会 `root.clear()` 重建纯文本文档，把草稿里**每一个**气泡碾平。原来的降级路径在有气泡的草稿上会毁掉用户已有的引用。

**为什么 `clipboardText` 取短形态**：会话重挂载时宿主用持久化的草稿串回灌（`setDraft` 无法从字符串恢复气泡节点）。`clipboardText` 若存整段围栏正文，退化后就是最刺眼的那种铺满输入框；存 `path:lines` 则只退化成一行。

## 5. 验证

- `pnpm typecheck` / `pnpm lint` / `pnpm build` 通过。
- `pnpm test`：**2794 passed / 4 failed**，4 例全是本机 `tests/fs-operations.spec.ts`、`fs-mkdir.spec.ts`、`file-stream-route.spec.ts` 创建符号链接报 `EPERM`（Windows 权限差异）。已在干净 `dev` 上复现同样的 4 例，与本改动无关。
- 本改动相关：`tests/conversation-draft.spec.ts` 50 passed（含 `foldClipboardOffset` 8 例、`insertDraftReference` 6 例、有气泡草稿上的 `appendToDraft` 3 例）、`tests/selection-payload.spec.ts` 16 passed、`tests/selection-popup.spec.tsx` 8 passed。
- 真机 mount lane：新增探针在 markdown 预览里选中一行、点提交按钮，断言 composer 里出现 `diagram.md:` 气泡，且草稿文本不含三反引号围栏。

## 6. 已知边界

- 气泡的 `clipboardText` 取 `label`（文件引用另取 `@path`），`ref` 存发送用的完整正文，宿主提交前 `trim`。
- 全空白草稿上插入会留一个前导空格（宿主只允许整气泡替换）。
- 气泡路径不调用 `placeComposerCaretAfterInsert`：宿主事件本身接管光标，DOM 光标恢复只服务 `setDraft` 那条路径。
