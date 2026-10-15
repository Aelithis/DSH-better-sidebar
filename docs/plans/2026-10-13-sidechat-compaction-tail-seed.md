# 侧边对话启动慢：种子改为从最后一次 compaction 切尾（可验证等价）

> 2026-10-13 起，2026-10-15 二审后重构为 v2 构造 · 配套变更：`src/sidechat-core.ts` `compactionTail` + `tests/sidechat-compaction-seed.spec.ts`（11 例）

## 问题

`sidechat.start` 把父会话的**整份事件日志**复制进子会话当种子（`buildSidechatInheritance` → `copyEvents` 全量），且宿主 `agents.create({ seed })` 会把它**物理落盘**。在一个真实部署上（生产库只读实测）：

- 最大的侧边对话子会话 `seed_length = 32,674`，`events` 表物理 **32,675 行**——每个 fork 都复制了一遍父日志；
- 36 个播种会话合计复制 **303,018 行 / 276.5 MB（zstd 后）**，而全库 `events` 只有 292 万行、3.8 GB——fork 的写放大同时是**库膨胀**的主导项之一；
- 被频繁 fork 的主会话 35,992 事件且持续增长；宿主侧建会话成本与种子规模线性相关（`CREATE_TIMEOUT_MS = 15_000` 就是对它的防御）。

## 为什么「从 compaction 切」是安全的

DSH 的 compaction 机制（`dsh-compaction` / `compaction-basic`）：

- 四种 `compaction/*` 事件都是 **log-only**（不进模型可见面）；
- 真正的 surface 替换者是紧跟 `compaction/summary` 之后那条 **checkpoint `user/message`**（携带 `surfaceOp: replace`，相邻性是 shadow-price 契约）——它把被压缩的旧段从**模型可见面**上换掉；受保护的 0 号节点（system 头）不被 region 覆盖；
- 被替换的旧事件只留在日志里供确定性回放，**模型从此看不到它们**。

因此判据是：**只要子会话折叠出的 surface 与父当前 surface 逐节点相同，模型请求与 provider 上下文缓存前缀就和全量 fork 完全一致**。最近的测量也支持收益：主会话最后一个 summary 在 seq 34,324 / 日志 35,992，切尾后事件量约 4–15× 下降（取决于 compaction 新鲜度）。

## 设计（v2：只丢「被遗忘区段」，其余逐字保留）

`buildSidechatInheritance` 先尝试 `compactionTail(events)`，成功则以**重基后的日志**走原有逻辑（开轮闭合、dangling tool-call 快照全部原样复用），失败则回退今天的全量拷贝：

```
父日志:  [turn1: sys头+旧内容(被shadow)][keep-window 轮…][compaction 组+checkpoint][尾部…]
重基后:  [turn1 骨架: turn/start,step/start,sys头,step/end,turn/end]  ← 头部骨架包裹（关闭，因为关闭件在被丢弃区段里）
         [checkpoint（降级为 append，置于其 surface 表位——被遗忘区段的起点）]
         [keep-window 起(含其 turn/start)…切点）逐字]                    ← 骨架自然保留
         [切点后 …] 逐字（剔除本组 compaction 三个 log-only 记录）
```

1. **切割点** = 最后一个「后随 user/message」的 `compaction/summary` 的下一条事件（孤立 summary 回扫到上一个完整的）；
2. **头部** = 父最终 surface 上 checkpoint 表位之前的存活节点（通常就是受保护的 system 头），**包裹其所在 turn/step 骨架**：`turn/start + step/start + 节点 + step/end + turn/end`——关闭件从日志里取回，因为宿主会话关系不变量（`@deepseek-ai/dsh-session/invariant` 的 `requireOpenStep`）要求轮内事件必须点名一个打开的 turn/step，即便该轮其余内容已被压缩遗忘。头部跨多个 step/turn 的形状不构造（回退）；
3. **keep-window 与尾部逐字保留**：`lastTurnBoundary`/`hasDanglingToolCall`/合成闭合器因此**在重基日志上照常工作**（自动 compaction 必发生在打开的轮内——`compaction-basic` 由 `agent/pre-step` 触发且 region 强制 enclosed-in-turn——开轮的骨架在切点之前，逐字保留意味着永远不丢）；
4. **统一重基**：全部保留事件走同一个 `rebaseEvent`——seq 按位置重编号（seed 契约要求从 0 连续，宿主不重编号），`surfaceOp: replace` 范围、`sourceEventSeqs`、`developer/message.headerSeq` 等**向后引用**能映射则平移、映射不到则**诚实降级**（replace→append、引用删除），`headerSeq` 无法降级则整体回退；
5. **自证**：用宿主公开导出的真折叠 `foldSurface`（`@deepseek-ai/dsh-session/surface`，浏览器安全子路径）分别折父日志与重基结果，**逐节点比对可见消息序列**；不等价或折叠抛错 → 回退全量。新事件类型带来的「向后引用」长尾由此整体中和：要么折得过去，要么验证失败回退，永远不会产出坏子会话；
6. **回退** = 现行全量拷贝，行为逐字不变（无 compaction 的会话永远走这条路；探针实测五种形状回退输出与改前逐字节一致）。

### 证明范围与披露

- 等价证明覆盖**可见节点内容序列**；`request/header`/`request/context` 等模型装配输入中 log-only 的部分，keep-window 与尾部内的会随逐字保留带过去，更老的随区段丢弃——实测（二审探针，6 组工具集变化组合）：子会话首个请求经宿主 `projectToolUpdates` 投影后与全量 fork **完全一致**（子会话自建的 header 重置 declaration series），今天无可观测差异；此推理链无测试 pin，属已知边界。
- 日志含 `image/offload` 等 **MESSAGE_PROJECTION 事件类型**时 `foldSurface`（无 projections）抛错 → 回退全量（安全，但含图长会话拿不到收益）。同理，未来插件自定义 projection 不在 core 集合内时证明会失真为「回退」而非「假通过」。
- 孤立 compaction 组（summary 后替换未落地）的 log-only 记录随尾部保留（折叠不可见，保留宿主 metering 历史）；构造时剔除的只有**本次消费的那一组**。
- 第二个 system 头（checkpoint 表位之前的其他存活节点）实测受支持（二审探针 E：trim 生效、等价、validator 接受）。

## 明确不做

- 不做任意「最近 K 轮」截断——那会改变模型可见上下文与 provider 缓存前缀；
- 不做引用式继承（子会话直接引用父会话物理行）——需要动 dsh-session/session-persistence/format 的宿主变更，超出插件贡献面；
- 不加配置开关——回退路径本身就是安全阀；若上游评审要求可配置再加。

## 测试（`tests/sidechat-compaction-seed.spec.ts`，11 例）

夹具为宿主真实形状：`system/message {turn, step, message}`（`source.kind: 'system-prompt'`）、`tool/result` 挂 `message`、assistant 消息带 `model` source；compaction 组含手动（`turn: null`）与自动（`turn: <open turn>`）两种形态，且**开轮的 turn/start 与首条消息在切点之前**（二审 B1 的触发形状）。

1. 切尾发生：被 shadow 旧段（含 `tool/call`）整体消失，头部以闭合骨架 `[turn/start, step/start, system/message, step/end, turn/end]` 保留，keep-window 的 call→result 顺序保留，checkpoint 降级为 `append`、无残留引用，seq 从 0 连续；
2. **surface 等价**（核心不变量）：`foldSurface(重基种子)` 可见序列 == 父日志可见序列；
3. **真实验证器 + 真实关系不变量**：`Session.create(isSeeded + inherited cut)` 接受；`@deepseek-ai/dsh-session/invariant` 对父日志、切尾种子、全量对照全部零失败；
4. 无 compaction → 全量逐字拷贝（回归守卫）；
5. 回退（尾部 `developer/message` 引用被丢弃区段）→ 与改前行为**逐事件相同**（类型序列全等断言，非仅文本查找）；
6. 回退（尾部 replace 覆盖存活的前切点节点）→ 同上；
7. **轮内 compaction + 开轮普通消息** → trim 照常发生 + 合成 `step/end`/`turn/end{interrupted}` 闭合器照常落盘 + 不变量零失败；
8. **轮内 compaction + 悬空 tool call** → trim 照常发生 + 截在开轮前 + 结构化快照照常交付（providers 拒绝悬空 assistant 调用的保护不因切尾失效）；
9. **重映射**：尾部 replace 范围完全在尾内 → 保留为重基后的 replace（非降级），trim 必须发生、等价必须成立；
10. **孤立 summary 回扫**：最新 compaction 的替换未落地 → 沿用上一个完整 compaction（trim 仍生效），死组的 log-only 记录随尾部保留；
11. 真实验证器验收（`Session.create` + end-seed 标记落为子会话第一个 own event，与全量线程同形）。

判别性（全部实测过红）：
- 去掉「头部按 surface 序发射/骨架包裹」→ 例 1 / 例 3 当场红（后者由 invariant 拒绝）；
- 毁掉尾部 replace 重映射/降级分支 → 例 9 当场红；
- 孤儿 summary 不回扫 → 例 10 当场红。
**披露**：`sameVisibleSequence` 终验单独变异不可由行为测试变红（它是纵深防御，只有与构造缺陷叠加才可观察——二审的 B1 修复前正是「构造缺陷 + 守卫被绕过」的叠加形态，例 7/8 就是为此而设）。

## 独立审查记录（两轮，双 corpus 投票）

一审（2026-10-15，Standards + Spec 双轴，独立 subagent）：两票均 **CHANGES_REQUIRED**，blocking 收敛于同一根因——v1 构造只保留 surface 节点，把前切点的 turn/step 骨架丢掉：(a) 自动 compaction 必在打开的轮内，开轮的 `turn/start` 被丢后 `lastTurnBoundary` 返回 -1，悬空 tool-call 守卫与合成闭合器被静默绕过；(b) 违反宿主 `requireOpenStep` 关系不变量。两位审查者各留树外证据脚本（`check-midturn` / `check-invariant` / `probe1-5`），v2 修复后全部转绿（见上）。二审记录于 PR。

## 部署验证（已执行，2026-10-15）

第二实例（3097 端口、独立 `DSH_HOME`、生产库 `sqlite3 .backup` 在线快照、生产 PID 全程 669050 未动；凭据 `.credentials.yaml` 复制后重启）：

- 对真实主会话（35,992 事件、14 次 summary compaction）`POST /sidebar/api/sidechat.start` → **701 ms** 返回；
- 子会话 `seed_length = 2,641`、物理 2,643 行——**13.6×**（旧式同父 fork 为 32,674）；
- 请求装配（`system/message`、user 消息、`request/header`、`request/context`）全通过真实管线；
- 重启 staging 后**冷恢复**该切尾子会话并提问，模型凭被压缩的旧历史（只存在于 checkpoint 摘要中）给出准确回答（Mint vs Tinker loss 分歧、GLM-5.3 304B LoRA SFT、Megatron-LM #43 等细节）——上下文等价的行为级证明。
