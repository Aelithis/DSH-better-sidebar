# 侧边对话启动慢：种子改为从最后一次 compaction 切尾（可验证等价）

> 2026-10-13 · 配套变更：`src/sidechat-core.ts` `compactionTail` + `tests/sidechat-compaction-seed.spec.ts`

## 问题

`sidechat.start` 把父会话的**整份事件日志**复制进子会话当种子（`buildSidechatInheritance` → `copyEvents` 全量），且宿主 `agents.create({ seed })` 会把它**物理落盘**。在一个真实部署上（生产库只读实测）：

- 最大的侧边对话子会话 `seed_length = 32,674`，`events` 表物理 **32,675 行**——每个 fork 都复制了一遍父日志；
- 36 个播种会话合计复制 **303,018 行 / 276.5 MB（zstd 后）**，而全库 `events` 只有 292 万行、3.8 GB——fork 的写放大同时是**库膨胀**的主导项之一；
- 被频繁 fork 的主会话 35,992 事件，且还在增长；宿主侧建会话成本与种子规模线性相关（`sidechat-routes.ts` 的 `CREATE_TIMEOUT_MS = 15_000` 就是对它的防御）。

## 为什么「从 compaction 切」是安全的

DSH 的 compaction 机制（`dsh-compaction` / `compaction-basic`）：

- 四种 `compaction/*` 事件都是 **log-only**（不进模型可见面）；
- 真正的 surface 替换者是紧跟 `compaction/summary` 之后那条 **checkpoint `user/message`**（携带 `surfaceOp: replace`，相邻性是 shadow-price 契约）——它把被压缩的旧段从**模型可见面**上换掉；
- 被替换的旧事件只留在日志里供确定性回放，**模型从此看不到它们**。

因此判据是：**只要子会话折叠出的 surface 与父当前 surface 逐节点相同，模型请求与 provider 上下文缓存前缀就和全量 fork 完全一致**——不需要逐字段论证请求装配。最近的测量也支持收益：主会话最后一个 summary 在 seq 34,324 / 日志 35,992，切尾后事件量约 4–15× 下降（取决于 compaction 新鲜度）。

## 设计

`buildSidechatInheritance` 先尝试 `compactionTail(events)`，成功则以**重基后的日志**走原有逻辑（开轮闭合、dangling tool-call 快照等全部原样复用），失败则回退今天的全量拷贝：

```
父日志:  [sys][被 shadow 的旧轮…][keep-window 轮…][compaction 组+checkpoint][尾部轮…]
重基后:  [sys][checkpoint(降级为 append)][keep-window 轮…][尾部轮…]
              ↑按父 surface 的节点顺序发射     ↑log 序 + 引用手术
```

1. **切割点** = 最后一个 `compaction/summary` 的下一条事件（checkpoint），形状不符则回退；
2. **头部**（父 surface 上 checkpoint 表位之前/之后的**存活**前切点节点，通常是系统头 + keep-window）按 surface 顺序降级为 `append` 重发——它们当初没被 shadow，append 即精确；存活的 `tool/result` 补插自己的 `tool/call`（call 是 log-only，fold 不会保留）；
3. **尾部**（checkpoint 之后的事件）按 log 序重基：seq 按位置重编号（seed 契约要求从 0 连续，宿主不重编号）；`surfaceOp: replace` 的范围、`sourceEventSeqs`、`developer/message.headerSeq` 等**向后引用**能全部映射则平移，映射不到则**诚实降级**（replace→append、引用删除），`headerSeq` 无法降级则整体回退；
4. **自证**：用宿主公开导出的真折叠 `foldSurface`（`@deepseek-ai/dsh-session/surface`，浏览器安全子路径）分别折父日志与重基结果，**逐节点比对可见消息序列**；不等价或折叠抛错 → 回退全量。新事件类型带来的「向后引用」长尾由此整体中和：要么折得过去，要么验证失败回退，永远不会产出坏子会话；
5. **回退** = 现行全量拷贝，行为逐字不变（无 compaction 的会话永远走这条路）。

## 明确不做

- 不做任意「最近 K 轮」截断——那会改变模型可见上下文与 provider 缓存前缀；
- 不做引用式继承（子会话直接引用父会话物理行）——需要动 dsh-session/session-persistence/format 的宿主变更，超出插件贡献面；
- 不加配置开关——回退路径本身就是安全阀；若上游评审要求可配置再加。

## 测试（`tests/sidechat-compaction-seed.spec.ts`，8 例）

夹具覆盖：系统头（受 surface 0 位保护）、带 tool 配对的被 shadow 旧轮、带 tool 配对的 keep-window、compaction 组、带 tool 配对的尾部轮。

1. 切尾发生：被 shadow 旧段（含其 `tool/call`）整体消失，keep-window 的 `call→result` 顺序保留，checkpoint 降级为 `append`、无残留引用，seq 从 0 连续；
2. **surface 等价**（核心不变量）：`foldSurface(重基种子)` 的可见序列 == 父日志的可见序列；
3. 无 compaction → 全量逐字拷贝（回归守卫）；
4. 回退：尾部 `developer/message` 引用被丢弃的头部 → 全量拷贝；
5. **真实验证器**：`Session.create(isSeeded + inherited cut)` 接受重基种子（历史上 surfaceOp 剥离 bug 的检出层）；构造器补的 `session/end-seed` 落为子会话第一个 own event，与现行全量线程同形；
6. 开轮 dangling tool-call → 照旧切在轮前 + 结构化快照；
7. **重映射**：尾部 replace 范围完全在尾内 → 保留为重基后的 replace（非降级），等价仍成立；
8. **交错回退**：尾部 replace 覆盖存活的前切点节点（会重排 surface）→ 回退全量。

判别性（已逐条实测）：关掉「头部按 surface 顺序发射」→ 例 1 当场红；毁掉尾部 replace 的重映射/降级分支 → 例 7 当场红。**披露**：`sameVisibleSequence` 终验单独变异不可由行为测试变红（它是纵深防御，只有与构造缺陷叠加才可观察——例 7 的变异正是被终验拦截的实例）；表面 0 位保护、`system-prompt`/`model` 消息源等形状约束由例 5 的真实验证器背书。

## 部署验证

构建装进 3097+ 口的独立第二实例（独立 `DSH_HOME` + 会话库快照）端到端验证：fork 一个带 compaction 的大会话，断言 (a) 子会话事件数显著小于父会话、(b) 子会话能收到带完整上下文的首答（边界提示之后的回答引用旧轮内容）、(c) 生产实例 PID 全程不动。
