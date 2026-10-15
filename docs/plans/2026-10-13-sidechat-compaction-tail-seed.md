# 侧边对话启动慢：种子改为从最后一次 compaction 切尾（可验证等价）

> 2026-10-13 起，2026-10-15 五轮独立审查后为 v6 构造 · 配套变更：`src/sidechat-core.ts` `compactionTail` + `tests/sidechat-compaction-seed.spec.ts`（17 例）

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
4. **统一重基**：全部保留事件走同一个 `rebaseEvent`——seq 按位置重编号（seed 契约要求从 0 连续，宿主不重编号）；**`data.turn` 重编号**（宿主 turn 计数器必须连续跑 1,2,3…，被丢弃区段留下的轮号空洞由 keep/尾部整体下移填补；`step` 按轮重置故逐字保留即可）；`surfaceOp: replace` 范围、`sourceEventSeqs`、`developer/message.headerSeq`、以及 **`compaction/summary|prune` 记录的 `shadowedRange`/`shadowedSeqs`** 等**向后引用**能映射则平移；映射不到时 `headerSeq` 整体回退，而 compaction 计量记录**整条丢弃**（它计量的区段在子会话里不存在）。首个被保留的 `turn/start` 可能在 keep 区间**或**（pre-cut 存活者只有受保护头时）只在尾部，两段都要扫；
4b. **头部骨架归一**：存活头部（含被 mid-session 改写的受保护 system 头，任意原始 turn/step）一律归一为 **turn 1 step 1**——只改写事件里**已有**的数字信封字段（user/message 从不带、也绝不注入，它的整份 data 就是模型可见消息）；关闭件从日志取回、同样归一；
4c. **replace 目标不跳过**：keep 区间里被 checkpoint shadow 的 surface 节点跳过，**但仍是某个存活替换事件之 replace 目标的节点不跳**（pruner 的 tool/result 改写正是此形）——否则替换会被迫降级为落在已闭合 step 之后的 append，违反关系规则；
5. **中段切点**（宿主 region 边界只受 tool-pairing 平衡约束、可止于轮中）：keep 区间内**跳过被 checkpoint shadow 掉的 surface 事件**（同轮早期节点）与**孤儿 tool/call**（其 result 未存活），骨架照发——空 step 合法；
6. **自证**：用宿主公开导出的真折叠 `foldSurface`（`@deepseek-ai/dsh-session/surface`，浏览器安全子路径）分别折父日志与重基结果，**逐节点比对模型可见内容**——token 镜像宿主投影：`user/message` 比整份 `data`，其余比 `data.message`（信封 turn/step/headerSeq 天然不在其中；spec 的 oracle 也用宿主 `deriveEventMessage`，不与实现共用投影）；再加四道**关系门**——`turnSequenceValid`（镜像宿主 invariant 的计数与配对核心：轮号连续、无嵌套开轮、step 序号连续且开合于所属轮、轮内消息与 `tool/call` 点名开轮/开步、非 append `tool/result` 豁免、pending call 须被消费、step 不得带 pending 关闭）；`inboxSplicesValid`（镜像宿主持久 inbox 折叠：位置拼接、已知 target、重复 id 拒绝）；`bracketsValid`（镜像宿主成组记录：成功 `compaction/end` 须有同 id 的 `compaction/summary`、`command/done` 须有先行的 `command/run`——四审证明「只丢计量记录」会拆散成组记录、宿主 companion 拒绝而三道自证全盲）；可见序列等价。不等价、折叠抛错或任一门失败 → 回退全量。这是核心镜像而非宿主全契约——凡是门证明不了的，一律回退。
6. **回退** = 现行全量拷贝，行为逐字不变（无 compaction 的会话永远走这条路；探针实测五种形状回退输出与改前逐字节一致）。

### 证明范围与披露

- 等价证明覆盖**可见节点内容序列**；`request/header`/`request/context` 等模型装配输入中 log-only 的部分，keep-window 与尾部内的会随逐字保留带过去，更老的随区段丢弃——实测（二审探针，6 组工具集变化组合）：子会话首个请求经宿主 `projectToolUpdates` 投影后与全量 fork **完全一致**（子会话自建的 header 重置 declaration series），今天无可观测差异；此推理链无测试 pin，属已知边界。
- **回退（安全、无收益）的已知形状**（四轮探针实测）：**宽头**（受保护头之外还有存活 pre-cut 节点且含 tool/result——需经公开 `compactRegion` 任意区间接缝或第三方 backend 才可达，随包 backend 的 region 恒起于 surface index 0/1）；**单轮父会话**（compaction 发生在唯一仍在打开的轮内、无 keep 区间）；**cut 之后被改写的受保护头**（存活 node 0 是 post-cut 替换、pre-cut 扫描找不到头——四审实测六个最重会话三个命中，含 32675 事件的旧式 fork 子会话；生产主会话不受影响）；父日志本身违反关系不变量（子会话回退后与 legacy 逐字节一致 = parity）；审查者 p1-A 的多 step 中段复合形状。**已支持**（探针实证）：中段切点（keep 首轮部分被 shadow，含跨多 step）、context-overflow（keep 只剩末节点）、**被改写的受保护头**（原始 turn/step 任意、cut 之前——归一后 trim 生效）、**pruner 替换在 keep 窗口**（replace 目标保留重放 + 非 append 豁免 + 计量记录引用重映射或丢弃）、**keep 窗口起点的 inbox insert 回吞**（真实 loop 顺序 `[insert][turn/start][claim]`——v4 e2e 在生产主会话上抓到并修复）、空 keep 区间、**级联 compaction（含同轮后组吞前组 checkpoint——成组原子丢弃）**、**引用失配的孤立 summary 与命令括号（v6 起原子丢弃，fuzz/probe 实证 invariant 全清）**、命令 run+done 同窗（`sourceEventSeq` 重映射）、**真实多组会话**（主会话 14 组 compaction：953 ms、seed 3,457、fuzz 129 trim/3000 全清）。keep 窗口内 `request/header` + `developer/message.headerSeq` 成功重映射由三轮审查者探针钉住（`probe-header-remap`：指向重基后 header、trim、invariant 0/0）。
- 日志含 `image/offload` 等 **MESSAGE_PROJECTION 事件类型**时 `foldSurface`（无 projections）抛错 → 回退全量（安全，但含图长会话拿不到收益）。同理，未来插件自定义 projection 不在 core 集合内时证明会失真为「回退」而非「假通过」。
- 孤立 compaction 组（summary 后替换未落地）的 log-only 记录随尾部保留（折叠不可见，保留宿主 metering 历史）；构造时剔除的只有**本次消费的那一组**。
- 第二个 system 头（checkpoint 表位之前的其他存活节点）实测受支持（二审探针 E：trim 生效、等价、validator 接受）。

## 明确不做

- 不做任意「最近 K 轮」截断——那会改变模型可见上下文与 provider 缓存前缀；
- 不做引用式继承（子会话直接引用父会话物理行）——需要动 dsh-session/session-persistence/format 的宿主变更，超出插件贡献面；
- 不加配置开关——回退路径本身就是安全阀；若上游评审要求可配置再加。

## 测试（`tests/sidechat-compaction-seed.spec.ts`，17 例）

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
11. **中段 keep-window**：region 止于 keep 首轮之内 → 被 shadow 的同轮早期节点与孤儿 tool/call 被跳过、骨架完整、等价成立、invariant 零失败；
12. **改写头**（turn 1 后续 step 的 SystemPromptProjection.replace 形状）→ 归一为 turn 1 step 1 后 trim 照常、原 prompt 消失、等价、invariant 零失败；
13. **pruner 改写 keep 窗口结果**（两 step 之间的替换、携带原始 turn/step）→ replace 目标保留重放、替换 op 重映射、prune 记录引用重映射、等价、invariant 零失败；
14. **keep 窗口起点的 inbox 括号**（`[insert][turn/start][claim]` 真实 loop 顺序）→ insert 回吞、位置折叠可重放（真投影由树外探针与 e2e 覆盖）；
15. **同轮双成功 compaction、后组吞前组 checkpoint** → bracket 门回退（对照：去掉被消费组后 cp0 独立成切点、照常 trim）；
16. **命令括号**：run 落被遗忘区段、done 存活 → 回退；run+done 同在 keep 窗口 → trim 且 `sourceEventSeq` 指向重基后的 run；
17. 真实验证器验收（`Session.create` + end-seed 标记落为子会话第一个 own event，与全量线程同形）。

夹具使用**真实轮距**（受保护头 turn 1 + 被 shadow 的整轮 + keep 轮 3 起）——二审证明「keep 恰为 turn 2」的唯一连续夹具会让 invariant 用例假绿。

判别性（全部实测过红）：
- 去掉「头部骨架包裹」→ 例 1 / 例 3 当场红（后者由 invariant 拒绝）；
- 毁掉尾部 replace 重映射/降级分支 → 例 9 当场红；
- 孤儿 summary 不回扫 → 例 10 当场红；
- 关闭 turn 重编号 → 例 3（真实轮距 invariant）当场红；
- 三审变异复验：关 turnOffset 5/12 红、去骨架包裹 6/12 红（含点名用例）；
- 四审变异复验（树外隔离副本）：抽 `replaceCovered.add` → 恰 pruner 用例红；去头部 step 归一 → 恰改写头用例红。
**披露**：`sameVisibleSequence` 终验单独变异不可由行为测试变红（它是纵深防御，只有与构造缺陷叠加才可观察——二审的 B1 修复前正是「构造缺陷 + 守卫被绕过」的叠加形态，例 7/8 就是为此而设）。

## 独立审查记录（两轮，双 corpus 投票）

一审（2026-10-15，Standards + Spec 双轴，独立 subagent）：两票均 **CHANGES_REQUIRED**，blocking 收敛于同一根因——v1 构造只保留 surface 节点，把前切点的 turn/step 骨架丢掉：(a) 自动 compaction 必在打开的轮内，开轮的 `turn/start` 被丢后 `lastTurnBoundary` 返回 -1，悬空 tool-call 守卫与合成闭合器被静默绕过；(b) 违反宿主 `requireOpenStep` 关系不变量。→ v2：只丢被遗忘区段，头部骨架包裹，keep/尾部逐字。

二审（同日，两位全新 fresh reviewer）：两票再次 **CHANGES_REQUIRED**，独立收敛于新 blocking——**turn 编号断档**（v2 头部骨架收口后计数器期望 turn 2，keep 窗口逐字保留原始 `turn/start{N}`；两道自证 foldSurface/Session.create 都抓不到，真实 harness 在 `sessions.create` 抛 `InvariantError`）；另指出中段切点（region 边界仅 tool-pairing 平衡）会静默回退。→ v3：turn 重编号（keep ∪ 尾双段扫描首个保留轮）、中段 keep-window 跳过被 shadow 节点与孤儿 call、运行时 `turnSequenceValid` 关系门、夹具换真实轮距。

三审（同日，两位全新 fresh reviewer）：两票 **CHANGES_REQUIRED**——(a) 头部骨架 step 号未归一（受保护头被改写到 turn 1 step ≥2 时产出宿主 invariant 拒绝的种子）；(b) 宽头存活 `tool/result` 丢配对 `tool/call`；(c) keep/尾保留的 compaction 计量记录 `shadowedRange/shadowedSeqs` 未重映射（违反 dsh-compaction invariant）；(d) 关系门对**非 append** `tool/result` 过严（pruner 替换会让 trim 无谓回退）；(e) lint 死赋值。→ v4：头部归一 turn 1 step 1（只改写已有数字信封字段——期间发现并修复了「向 user/message 注入 turn/step」的真等价破坏，token 改为镜像宿主投影：user=整份 data、其余=data.message）、关系门补 nextStep/pendingCalls/嵌套开轮/非 append 豁免、compaction 记录引用重映射或整条丢弃、**replace 目标节点不跳过**（pruner 形状由此从回退转为生效）。

五审（delta 终验 + 真实数据复测，对象 cc11ce4 并对工作树并发改动钉版复核）：抓到 v5 两处回归并当场修复。(a) bracket 门在真实多组会话上**全量回退**——e2e 实测主会话 seed=35,993、9,077 ms（全量拷贝旧路径）；根因是真实多组会话的 mid-keep 组 summary 引用全指向被后续组 re-shadow 的节点，记录级丢弃拆散成组记录。→ 修法取审查者给的第二选项并经数据背书：**成组原子丢弃**（发射前定 emittedSeqs，引用失配的 compaction 组 start/summary/end 整组丢、失 run 的 command/done 单独丢）；fuzz 3000 例 trim 108→129 全过真 session+compaction+commands invariant 与真 inbox 折叠、0 命中，四审级联反例 pG 从回退翻转为干净 trim。(b) v5 把缺失 `removedCount` 当非法——宿主契约它**可选、缺省 0**（宿主写入方对纯插入省略它；生产库 54% splice 如此；89 个真实 compaction 会话 38 个因此回退，含主会话）→ 还原 `?? 0`。五审实证 v5 在 89 个真实会话 trim 41→3 的覆盖率崩塌即此二回归合成。用例 15 夹具按宿主链式 replace 语义重写（吞**当时** surface span），从空测（夹具本身折不动、断言恒真）翻转为真钉子。终版 e2e（ad42628）：**953 ms / seed 3,457（10.4×）**、冷上下文回答再命中 exp5 收尾细节（fsr-ge7-top5-5e5-allfix、1.02×→1.18× 分叉消失、2900x 收尾三件事）。

四审（同日，两位全新 fresh reviewer，对象 657dcd5 → tip 196fa11 两版钉证）：核心等价性**未能证伪**（2100 生成形状、113 次 trim 全过真 session invariant + 真 Session.create + 真持久 inbox 投影 + 真 `deriveEventMessage` wire 比对；非 trim 全与 legacy 逐字节一致），但两票各在同一根因上给 blocking——**宿主「成组记录」被只丢计量记录拆散**：(a) 成功 `compaction/end` 失去同组 `compaction/summary`（同轮双 compaction 形状，随机实测命中 trim 的 18.6%，真 dsh-compaction invariant 拒绝而三道自证全盲）；(b) 657dcd5 的 keep 窗口丢掉紧邻 turn/start 前的 inbox INSERT、保留其后的 CLAIM（真实持久 inbox 投影拒绝——**v4 e2e 在生产主会话上当场抓到**：`thread creation failed: invalid persisted inbox splice at session seq 7`）。→ v5：keepStart 回吞前置 splice + `inboxSplicesValid` 门（e2e 复测：**799 ms**、seed 3,457 = 35,992 的 **10.4×**、冷上下文回答再命中压缩摘要细节）；`bracketsValid` 门（成组记录原子性：compaction bracket + command 配对）；`command/done.sourceEventSeq` 重映射；spec oracle 换宿主 `deriveEventMessage`；补同轮双 compaction 与命令括号两用例（17 例）。Standards 另修：`expectedFirstKeptTurn` 按骨架实际 turn/start 判定（N2）、`inboxSplicesValid` 收紧到宿主严格度（N4）、post-cut 改写头回退形状入披露（S3，六会话三命中）。四轮审查者的全部树外证据脚本在 v5 上全部转绿或按设计安全回退。

## 部署验证（已执行，2026-10-15）

第二实例（3097 端口、独立 `DSH_HOME`、生产库 `sqlite3 .backup` 在线快照、生产 PID 全程 669050 未动；凭据 `.credentials.yaml` 复制后重启）：

- 对真实主会话（35,992 事件、14 次 summary compaction）`POST /sidebar/api/sidechat.start` → **701 ms** 返回；
- 子会话 `seed_length = 2,641`、物理 2,643 行——**13.6×**（旧式同父 fork 为 32,674）；
- 请求装配（`system/message`、user 消息、`request/header`、`request/context`）全通过真实管线；
- 重启 staging 后**冷恢复**该切尾子会话并提问，模型凭被压缩的旧历史（只存在于 checkpoint 摘要中）给出准确回答（Mint vs Tinker loss 分歧、GLM-5.3 304B LoRA SFT、Megatron-LM #43 等细节）——上下文等价的行为级证明。
