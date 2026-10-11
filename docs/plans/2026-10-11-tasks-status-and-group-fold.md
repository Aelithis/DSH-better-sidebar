# 任务管理页：小条只说原生状态 + 按组展开 + 浮窗活动行

日期：2026-10-11　分支：`feat/tasks-status-and-group-fold`（自 `dev` 顶端 `64a61cc` 切出）

## 背景：用户 brief（原文）

> 优化任务管理面板：
> - 下方条不再显示运行中，进行中时直接写为：正在分析请求/正在准备读取文件/正在更新计划等待这个原生的状态，现在往往大部分时间是一直显示正在分析请求
> - 最近活动的内容可以以小字号的形式写到标题下方
> - 优化下展开/折叠的逻辑，不要点一个展开就把全部都展开
> - 其他你认为需要优化的UI部分
>
> 保持KISS原则，如有任意不清楚的地方，都向我详细确认

「下方条」经确认 = 图模式卡片的下方小条（`src/client/tasks-card.tsx` 的 `CardBar`），它当时的真机读数见
[2026-09-27-tasks-graph-polish.md](2026-09-27-tasks-graph-polish.md) G1：根卡 `主代理 / … / 运行中 / 正在分析请求`。

## 用户确认的决策（问答摘要)

| # | 问题 | 结论 |
|---|---|---|
| 1 | 「下方条」范围 | **图模式小条**：状态点 ＋ 原生状态，不再出现「运行中」；**树模式行内 meta 保持现状**（仍是「一次性 · 运行中」），本轮不动 |
| 2 | 「一直是正在分析请求」怎么处理 | **两处都修**：① 根卡接上 live 数据；② 浮窗按节点状态取措辞、无数据就不显示该行 |
| 3 | 「最近活动」写到哪里 | 节点详情浮窗**去掉「最近活动」标签**，内容以 10px 小字写在标题下方（对应词条一并删除） |
| 4 | 展开/折叠语义 | **点聚合卡只展开该组**；控制条按钮仍是全局展开/折叠 |
| 5 | 其它 UI 优化（多选） | ✅ 树模式实时行图标按活动类别取 ✅ 已结算小条同样去重（不显示「已完成」） ✅ 聚合卡不再两处都写计数 |

## 现状与根因（读码核实，非推测）

1. **小条渲染两段**：`CardBar` = `[状态点] 状态词 + 活动行`。运行中卡片因此是「● 运行中 正在运行命令 · npm run build」——状态词与活动行说了同一件事。
2. **根节点没有 live**：`buildTasksModel` 的根节点字面量不含 `live` 字段（子节点有），而 `subagent-live-route.ts` 早已把根的 fold 结果放进 `live[rootSessionId]`。于是**主代理卡片的状态文本恒为 `liveActivityLabel(undefined)` 的 thinking 兜底**，它与主会话在做什么无关——这就是「大部分时间一直显示正在分析请求」的第一处真因。
3. **浮窗的活动行恒有话说**：`AgentNodePopover` 用 `liveActivityLabel(node.live?.summary)`；`summary` 为 undefined 时宿主词典在真实部署里存在，函数返回 `message.stepProcess.thinking`（正在分析请求）。于是**每个节点的详情浮窗几乎恒显示「最近活动：正在分析请求」**，已结算节点也走运行中措辞——第二处真因。
4. **聚合点击 = 全部展开**：`SubagentView.expandFold()` 清空 `foldedIds` 并 `setFolded(false)`；树里的聚合行也是 `onToggleFold`（全局）。两处都是「点一个，全开」。
5. **聚合徽标印的是字母 N**：`tasksFoldIdleGroup` 在 20 份词典里都是字面量 `'N waiting' / 'N 个待命'`（无 `{count}` 插值），徽标因此永远显示「N 个待命」。
6. **树模式实时行恒画终端图标**：`LiveLine` 写死 `toolGlyph('bash')`，而 `tool-icons.tsx` 的工具名映射其余部分是死代码（该函数只有这一个调用点）。

## 关键设计

### 1. 状态词让位活动行（`CardBar`）

```
运行中卡片     ● 正在读取文件 · main.ts        ← 活动行取代状态词（原生措辞）
已结算卡片     ● 已读取文件、执行了命令        ← 同为活动行
空闲 / 出错    ● 空闲  …    ● 出错 已调用工具  ← 保留状态词
无任何数据     ● 运行中 / 已完成               ← 回退状态词，小条不空
```

- 判据：`activity` 非空且 `state` 不是 `idle` / `error` 时不渲染状态词。**`idle` 与 `error` 刻意保留**：「待命」「失败」不被任何活动措辞蕴含，去掉就是把那条小条唯一该说的话藏起来（这条写进了 `CardBar` 的 docstring）。
- 状态点、`data-running` 扫光、折叠 chevron 全部不变；卡片高度预算（小条恒 22px）不变，所以 `tasks-graph-layout.ts` 与画布几何零改动。

### 2. 一条共享的活动规则 `activityLine(node)`

`tasks-shared.tsx` 新增（卡片小条与详情浮窗共用，两处不可能再各说各话）：

```
summary === undefined            → undefined（调用方回退状态词，绝不谎报）
state === 'running'              → liveActivityLabel(summary)   // 宿主 message.stepProcess.*
否则（done / idle / error）      → doneActivityTitle(summary)   // 宿主 message.stepProcess.done.*
```

它替掉了 `TasksGraph` 里私有的 `barActivity`，也修掉了浮窗对已结算节点用运行中措辞的问题。

### 3. 根节点接上 live

`buildTasksModel` 的根节点 push 带上 `live: childLive(live, rootId)`（缺失时不挂字段）。
由此：主代理卡片显示真实状态；树模式根行的实时行也从恒定的「思考中…」变成真实活动。
`live[rootId]` 为空对象时行为退回状态词——这是**有意的**：不知道的事不说。

### 4. 按组展开

- 模型新增入参 `expandedGroups?: ReadonlySet<string>`，键是**组 id**：`foldGroupId(foldKind, parentId)` →
  `fold:<parentId>`（已完成组）/ `fold:<parentId>:idle`（待命组），`foldNode()` 与页面共用它，一处定义。
- 折叠判定只在「本来要折」的分支上追加一次询问：组被展开 → 该成员落回 `kept`（保持目录顺序），
  兄弟组、页级规则与逐节点手动折叠**都不受影响**。
- 页面：`expandGroup(node)` 把组 id 入集，并把 `node.memberIds` 从 `foldedIds` 摘掉
  （聚合点击的含义是「现在给我看这些节点」，不该被手工折叠留在里面）；
  **控制条收起时清空 `expandedGroups`**（全局收起必须真的收起），展开时不动它。
- 树里的聚合行同一语义，行内副文案固定为「展开」——该行只在折叠态存在，旧实现按页级 `folded` 写「折叠」是自相矛盾的。

### 5. 聚合卡计数只说一次

徽标是计数的家：待命组徽标改为 `tasksFoldIdleGroup` 的**真实插值**（`{count} 个待命`），小条只保留
`foldErrorTally(node)`（`出错 N`，无出错则空）＋展开箭头。完整 tally（`foldTally`）仍是卡片的
`aria-label` 与 tooltip —— 屏幕阅读器看不到徽标，只有这一条路。

### 6. 实时行图标按活动类别

`tool-icons.tsx` → `activity-icons.tsx`：`activityGlyph(kind: ProcessActivity | undefined)`，
`Record<ProcessActivity, Glyph>`（**类型强制全覆盖**，上游加类别会编译失败而不是静默兜底）。
`undefined`（尚未派发，宿主措辞就是「正在分析请求」）→ 思考图标。已删除无消费者的工具名映射。

## 实施偏差记录（写给复审）

1. **README 的 v0.22.0 发布说明改写了两条（zh 227/229）＋ en 对应两条**（计划里原写「同步 4 条」）。
   过程记录：`git log -L` 显示那四条自 2026-09-27 的发布提交后再未被任何提交碰过——它们是**冻结的发布历史**，
   而仓库的进行中通道是 `CHANGELOG.md` 的 `### Unreleased`（先例：`2f66c92` 的 #774 批次）。初版因此只写了
   CHANGELOG + 本文档并把偏差报给维护者；**维护者随后明确选择「现在就改写那四条」**，故按当前行为改写
   （小条只显示原生状态、聚合按组展开 + 徽标真实计数），CHANGELOG 的 Unreleased 段同时保留。
2. **`idle` / `error` 保留状态词**：用户选项只点名了「运行中」与「已完成」。这两个状态的活动措辞
   （子代理的 `done.*` 摘要）读起来都像「刚做完事」，去掉状态词会把「在等下一轮」「失败了」藏起来。
3. **`tasksFoldIdleGroup` 是插值改动而不是删词条**：它本来就是给徽标用的键，只是值写成了占位符
   `N`。改为 `{count} …`（zh/en/zh-HK/zh-MO/zh-TW/ja 各自保留自己的语序），20 份同批改。
4. **`tasksNodeActivity` 从 20 份词典删除**（不是留着不用）：浮窗那一行没了，留着就是死词条；
   `tests/locales.spec.ts` 的键集合相等守护要求这一次同批改完。
5. **`CardBar` 的判定写在组件里而不是调用方**：`stateWord` 是调用方参数（聚合卡传 false），
   「活动行取代状态词」是同一条呈现规则的内部细节，让每个调用点各判一次只会让两处漂移。
6. **树模式行内 meta 不动**（用户明确选择）。它仍是「一次性 · 运行中」＋下方实时行，
   与图模式小条的读法不同是有意保留的差异。
7. **自查抓到并修掉的一处判据反了**：按组展开的清空时机最初写在**展开**分支上
   （`if (folded) setExpandedGroups(∅)`），应该写在**收起**分支（`if (!folded) …`）——否则
   「页级展开 → 手工折一个 → 打开该聚合 → 点控制条收起」会留下那个组仍然展开，而兄弟节点全折了。
   已补 `tests/tasks-page.spec.tsx` 的「drops the per-group openings when the CLUSTER collapses the page」
   用例；把判据翻回去即红（实测），这条用例是判别性的。

## 验证证据

| 项 | 结果 |
|---|---|
| `tsc --noEmit`（等价 `pnpm typecheck`） | ✅ 0 错误 |
| `eslint .` | ✅ 0 错误 |
| `vitest run`（全套） | ✅ **2227 passed / 17 skipped / 0 failed**（190 文件） |
| `tsc -p tsconfig.build.json` + `tsdown` | ✅ 构建通过（核心 bundle 与三个 chunk 正常产出） |

本轮新增/改写的守护：

| 文件 | 内容 |
|---|---|
| `tests/tasks-model.spec.ts` | 按组展开（done 组开了、idle 组仍折叠；反向亦然）、组 id 就是聚合行 id、`expandedGroups` 盖过残留的手工折叠、run 成员组的展开、根节点带 live（含「无数据即无字段」） |
| `tests/tasks-page.spec.tsx` | 运行中小条 = 原生状态且**不含**「运行中」；无 summary 回退「运行中」；已结算小条不含「已完成」；根卡显示主会话真实状态；浮窗活动块位置/文案/无数据不渲染且不含「最近活动」「正在分析请求」；**一次点击只开一组、兄弟组仍折叠**，控制条全局收起把展开过的组重新折回（含那条判别性用例）；待命徽标真实计数、小条不再重复计数 |
| `tests/activity-icons.spec.ts`（新） | 13 个类别各渲染出元素；`read` / `commands` / `search` / `webSearch` 互不同型（钉住「不再恒画终端图标」）；`undefined` 走思考图标且不等于任何类别 |
| 既有期望跟随设计 | 待命聚合的 `'3 待命' / 'N 个待命'` → `'3 个待命'`（徽标插值） |

`tests/tasks-page.spec.tsx` 新增一个 `FakeChatLocale`（`active: 'zh'` + `bind('chat')` 供
`message.stepProcess.*`），`afterEach` 里 `attachLocale(undefined)`：**活动行的字来自宿主 `chat`
命名空间**，不挂这个假 locale 就只能断言到 fallback 的 detail，钉不住真正的契约。

## 未验证项（如实记录）

- **没有跑真机**：本 worktree 未装进任何 DSH profile，也没有起服务器。上面全部结论来自 jsdom 单测与构建产物；
  卡片小条的实际观感（原生状态与状态点/扫光的搭配、260px 窄栏下的省略行为）、浮窗那两行小字的真实换行
  都需要真机或截图复核。
- 因此也没有 `pnpm test:mount` 记录。
