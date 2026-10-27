# 冷会话 cwd 改读工作区地址（2026-10-27）

> **范围**：`sessionCwdOf()` 的冷（detached）分支、`activeWorktreeRootOf()` 的 detached 分支、`/sidebar/api` 的 `cwdOf()` 注释与 `sessionQuery` 类型镜像。
> **落点**：分支 `fix/workspace-cwd`（基线 `dev` `43db17f`）。
> **一句话**：插件要的只是一个「工作区地址」，此前却为此付出整份会话日志的解码；改为读存储 header（只读第一个 zstd 帧）后，冷会话的读次数从「每个入口一次」降到「每个会话一次 header」。

---

## 一、背景：0.28.1 为什么没修好

外部对比测试（2026-10-26）在 39,886,933 字节会话上实测：启动后 13–14 s 内、130–180 ms 窗口出现 **36 次整份读取**，0.28.0 为 44 次；单飞上线后几乎没动。报告据此判「去重未生效」。

代码核对（宿主 0.2.1-rc.2 产物）：

- 插件唯一的冷读入口是 `src/index.ts` 的 `sessionQuery.observeSession(id, { projectionMode: 'all' })`：宿主 `SessionObservationReader.read → loadSource → readColdSessionLog → persistence.open → requireStoredLog → readStableSnapshot → readFile`，整份读 + 全 zstd 帧解码 + 全投影水合，**插件只取其中 `workingDirectory` 一个字段**。
- 宿主这条链**没有任何 in-flight 合并**：`SessionObservationReader` 的 5 条 LRU 与 backend 的 2 条 `coldLogMemo` 都是「读完才写」，并发未命中就是并发整读。
- 0.28.1 的 `cwdInFlight`（`src/index.ts:651`）只包住 `/sidebar/api` 的 `cwdOf()`。**完整绕过它的有 6 个入口**：`/sidebar/upload`、`/sidebar/write`、`/sidebar/file`（每资源 GET）、`/sidebar/html`（预览 + 每相对资源）、`/sidebar/ws/fs-watch`（**每监视目录一帧**）、agent-open 回调。
- fs-watch 的帧在 `ws.on('message')` 里各自 `void` 起跑，且服务端**先解析 cwd 再判断 op**（`src/index.ts:1924`）；客户端 socket 打开时对 `[root, ...expanded]` 每个目录发一帧（`src/client/use-dir-watch.ts:113`）。所以「36 次」最自然的解释是「1 个根 + 35 个恢复的展开目录」，与单飞覆盖范围无关。

报告的另一个缺口：栈只截了 10 帧，止于 `SessionObservationReader.read`（此时已用掉 7–8 帧），**插件帧恰好落在截断处**；「无一帧来自插件」不能作为排除证据。

## 二、决定

**冷会话（宿主未 attach）的 cwd 取存储 header —— 即会话的工作区地址；不再调用任何会解码日志的 API。**

- 宿主 attach 之后（`ctx.sessions.get(id)` 有值）仍走 `workingDirectory.get(session)`，`cd` 进去的子目录和 linked worktree 照旧跟随。
- `activeWorktreeRootOf()` 对 detached 会话直接返回 base：跟随 worktree 需要折叠日志里的工具调用，detached 时那等于再解码一次整份产物。
- 客户端提示（session list 的 summary cwd）从「排在 observation 之后」降为「宿主答不上来时的兜底」，与它原本的定位一致。

## 三、代价（明确写出）

- 冷窗口内（启动恢复到会话 attach 之前，或从未打开过的会话）侧边栏根是**原始项目目录**，不是 agent 最后所在的子目录 / linked worktree。会话 attach 后，下一次 5 s `session.cwd` 轮询即切回 committed 目录。
- 相对路径、`~`、绝对路径的解析基准在冷窗口内随之变为工作区根；这与「工作区地址」的语义一致。
- 宿主若没有 `sessionPersistence.stat`（旧宿主），退化为客户端提示 → 进程 cwd；不再回退整份日志读。

## 四、实现

| 位置 | 变化 |
| --- | --- |
| `src/index.ts` `storedHeaderCwdOf()` | 新增：`sessionPersistence.stat()` 取 `header.cwd`，命中写进程级 `Map<sessionId, cwd>`（header 不可变，无需 TTL；上限 256），并发同会话共享一个在飞 promise；`stat` 缺失或失败返回 undefined（降级到提示，不打断路由）。 |
| `src/index.ts` `sessionCwdOf()` | 删除 `observeSession` 分支与 `readPersistedSession` 兜底；顺序改为 live committed → 存储 header（相对路径拒绝为 `bad-request`）→ 宿主 defaultDirectory → 客户端提示 → 进程 cwd。 |
| `src/active-worktree.ts` | `activeWorktreeRootOf()` 在 `ctx.sessions.get(id) === undefined` 时直接返回 base。 |
| `src/context-types.ts` | `SidebarSessionPersistenceService` 增加可选 `stat`；删除已无消费者的 `sessionQuery` 镜像。 |
| `tests/smoke.spec.ts` | 重写该组 8 例：header 优先于陈旧提示、header 只读一次、12 并发共享一次、无 `stat`/`stat` 失败回落提示、live committed 优先、相对 cwd 拒绝、defaultDirectory 兜底、进程 cwd 兜底。 |

## 五、验证

**已执行**：`pnpm typecheck` 通过；`pnpm exec vitest run tests/smoke.spec.ts tests/active-worktree.spec.ts` → 89 passed，1 failed（`serves a home-relative media path`，`mkdir $HOME/.dsh-sidebar-selftest-*` 被本会话文件沙箱拒绝；在未改动的 `dev` 上同样失败，判为环境限制）。

**未执行**：没有 39.9 MB 真机会话，未在本机复现「36 → ?」的读次数变化。可证伪预测：同一场景下 `readStableSnapshot` 的调用数应降到 **每个冷会话 ≤1 次**（header 读不走该函数时直接归零），且 fs-watch 帧不再触发任何整份读。

## 六、留下的读取面（不在本次范围）

- `changes.ops` 冷读整份日志（无 memo），`sidechat.events` 冷读有结果 memo 但无在飞去重。
- 这两条只在对应页签打开时触发，不是启动期风暴源；若后续要彻底消灭整读，再单独处理。
