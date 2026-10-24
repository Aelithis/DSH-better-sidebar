# 🚀 安装通道（可选）

> 本页从 [README](../README.md#-安装) 拆出：主安装方式只有一条 `dsh plugin --profile web add dsh-better-sidebar@latest`，
> 「从源码安装」与「plugin-registry 通道」属于可选路径，放在这里维护。

## 🧰 从源码安装 / 开发

调试本地改动或跟随开发分支时，把依赖指向本地克隆并自行构建：

```text
1. git clone https://github.com/omdsh-dev/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
2. ~/.dsh/profiles/web/package.json 的 dependencies 写 "dsh-better-sidebar": "link:<克隆目录绝对路径>"
3. ~/.dsh/profiles/web/cordis.patch.yml 追加挂载行（这一行的 config 就是本插件的设置表单，不写则全用 schema 默认值）：
   - insert:
       - id: better-sidebar
         name: 'dsh-better-sidebar'
         config:
           listLimit: 1000
4. 在 ~/.dsh/profiles/web 执行 pnpm install
5. 硬刷新浏览器（Cmd/Ctrl+Shift+R）；client 改动热加载，host 半改动才需重启
```

更新：`git pull && pnpm install && pnpm build` → 硬刷新。切回 npm 通道时把依赖改回版本号（当前线 `^0.26.0`）再 `pnpm install`。

---

## 📦 通过 plugin-registry 安装（与 npm 通道二选一）

前置：DSH 已集成 [plugin-registry](https://github.com/dsh-external/plugin-registry)（`dsh registry` 可用）。**同时启用两个通道会双挂载**（Node 半挂两次、页面两个侧边栏）。

```sh
git clone https://github.com/omdsh-dev/DSH-better-sidebar.git && cd DSH-better-sidebar
pnpm install && pnpm build
node scripts/package-registry.mjs   # 组装 registry/ 暂存（含清单 + 产物 + README，不入库）
dsh registry install ./registry     # 安装（默认禁用）
dsh registry enable dsh-external/dsh-better-sidebar
```

更新：`git pull && pnpm install && pnpm build` → `node scripts/package-registry.mjs` → `dsh registry uninstall/install/enable`。切换通道前先移除另一通道的挂载。

