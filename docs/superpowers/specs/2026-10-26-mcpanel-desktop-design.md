# MC Panel Windows 桌面版设计

> 日期：2026-10-26 · 状态：已确认（Electron） · 目标版本：v0.4.0 · 平台：Windows 10/11 x64

## 1. 目标

把现有 Web 面板包装成独立的 Windows 桌面应用：安装或双击便携 exe 后即可使用，
不需要浏览器、命令行或手动启动 Node 服务。

必须保持现有能力不变：实例纳管、启停、控制台、玩家、文件、配置、备份/恢复、
计划任务、审计与设置全部复用现有实现。

## 2. 非目标

- 不重写 Fastify 服务端和 React 前端。
- 不在本期实现 macOS/Linux 桌面版。
- 不在本期实现远程节点、多用户或移动端。
- 不在本期实现自动更新和代码签名；它们放到 v0.4.x。
- 退出桌面应用时**不停止 Minecraft 服务器**（沿用现有面板行为）。

## 3. 关键决策

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| 桌面壳 | Electron | 全部代码是 TS/Node；托盘、安装器、自启动、更新生态成熟 |
| 服务端运行方式 | 内置 Node 24 子进程 | `better-sqlite3`、`argon2` 不需要为 Electron ABI 重编译；崩溃隔离 |
| 安装形态 | NSIS 每用户安装包 + 便携 exe | 覆盖“安装即用”和“拷贝即用”两种使用习惯 |
| 数据目录 | `%APPDATA%\MC Panel`，支持导入和便携模式 | 安装版可写、可升级；便携版数据跟随 exe |
| 监听地址 | `127.0.0.1` + 随机空闲端口 | 避免端口冲突，不暴露局域网 |
| 自动更新/签名 | v0.4.x | 先交付可用的桌面 v1，降低首版风险 |

未选择 Tauri：虽然安装体积更小，但需要 Rust 外壳和 Node sidecar，
进程生命周期、原生依赖和 CI 都更复杂，不适合当前纯 TS/Node 项目的第一版。

## 4. 产物

| 文件 | 内容 |
| --- | --- |
| `MC-Panel-Setup-0.4.0.exe` | NSIS 每用户安装包（无需管理员） |
| `MC-Panel-0.4.0-portable.exe` | 便携版，单 exe 启动 |
| `mcpanel-0.4.0-win-x64.zip` | 保留现有服务器便携包，供无桌面环境使用 |
| `SHA256SUMS.txt` | 以上产物的 SHA-256 |

安装后目录（示意）：

```text
%LOCALAPPDATA%\Programs\MC Panel\
├─ MC Panel.exe
├─ resources\
│  ├─ app.asar                 # Electron main/preload
│  └─ server\                  # 复用的服务端 payload
│     ├─ node\node.exe
│     ├─ node_modules\
│     └─ apps\
│        ├─ server\dist\
│        └─ web\dist\
└─ locales\
```

用户数据不放在安装目录：

```text
%APPDATA%\MC Panel\
├─ data\                       # DATA_DIR
│  ├─ panel.db
│  ├─ secret.key
│  ├─ backups\
│  └─ logs\                    # 面板日志 + desktop.log（Electron/子进程输出）
├─ desktop.json                # 桌面偏好：自启动、关闭到托盘
└─ runtime.json                # 上次启动的 pid/port，用于孤儿检测
```

便携模式（检测到 `PORTABLE_EXECUTABLE_DIR`）把上述用户数据改到
`<exe 所在目录>\mcpanel-data\`。安装版与便携版使用独立数据目录，
可以同时运行；它们是两个独立面板，不共享登录状态或实例。

## 5. 架构

```text
Electron 主进程
├─ 单实例锁、托盘、开机自启、窗口
├─ ServerProcess
│  ├─ 选择 127.0.0.1 空闲端口
│  ├─ spawn resources/server/node/node.exe apps/server/dist/index.js
│  │    PANEL_HOST=127.0.0.1
│  │    PANEL_PORT=<free port>
│  │    DATA_DIR=<userData>\data
│  │    NODE_ENV=production
│  ├─ 轮询 /api/health（最长 30 秒）
│  └─ IPC：shutdown / disconnect
└─ BrowserWindow → http://127.0.0.1:<port>

服务端子进程
├─ 现有 Fastify + SQLite + RCON + 调度器
└─ 新增：收到 IPC shutdown 或父进程断开时调用现有 shutdown()
```

### 5.1 工作区

新增 `apps/desktop`：

```text
apps/desktop/
├─ src/main.ts             # app 生命周期、窗口、单实例
├─ src/server-process.ts   # 端口、spawn、health、退出
├─ src/tray.ts             # 托盘菜单
├─ src/preferences.ts      # desktop.json 读写
├─ src/preload.ts          # 最小 IPC 暴露
├─ tsup.config.ts
└─ electron-builder.yml
```

`apps/desktop` 不包含渲染层，窗口加载现有服务端托管的 Web 构建。

### 5.2 服务端改动

只增加桌面模式需要的 IPC 生命周期，不改变 HTTP API：

```ts
if (typeof process.send === 'function') {
  process.on('message', (message) => {
    if (message === 'shutdown') void shutdown('desktop', 0);
  });
  process.on('disconnect', () => void shutdown('desktop-disconnect', 0));
}
```

- `shutdown()` 是现有优雅退出函数，会停止调度器、关闭 RCON、关闭 SQLite。
- 不停止 Minecraft 子进程，与现有行为一致。
- 不新增 HTTP 关机接口，避免扩大攻击面。

### 5.3 端口与健康检查

- 主进程用 `net.Server` 绑定 `127.0.0.1:0` 取得空闲端口后立即释放。
- 子进程工作目录固定为 `resources/server`，启动入口为
  `resources/server/apps/server/dist/index.js`。
- 子进程启动后每 500ms 请求 `/api/health`，最长 30 秒。
- 如果子进程报端口占用，重新取一个空闲端口重试一次；仍失败则提示用户。
- 健康检查通过前显示“正在启动面板…”窗口或托盘提示；失败时弹窗显示
  `data/logs/desktop.log` 路径和“重试/退出”。

### 5.4 孤儿进程

- 启动时写入 `runtime.json`：`{ pid, port }`。
- 下次启动若发现 `pid` 仍存活且端口 `/api/health` 可用，只结束该 pid（不带 `/T`），
  等待最多 5 秒后启动新子进程；这样不会误杀 Minecraft 进程树。
- 正常退出时删除 `runtime.json`。
- 子进程意外退出时主进程显示错误对话框，提供“重启面板 / 打开日志 / 退出”。

## 6. 生命周期

### 6.1 首次启动

1. 确定数据目录（安装版/便携版）。
2. 如果 `data\panel.db` 不存在，显示导入对话框：
   - “从现有便携版导入…”：选择包含 `panel.db` 的 `data` 目录，复制
     `panel.db`、`secret.key`、`backups/`、`logs/` 到新数据目录；
   - “新建”继续，服务端会自动建库。
3. 启动服务端子进程并打开窗口；无管理员时进入现有 `/setup` 页面。

导入前如果目标目录已有数据，先提示覆盖风险；导入过程不做自动删除。

### 6.2 正常启动

1. `app.requestSingleInstanceLock()`；重复启动只聚焦已有窗口。
2. 读取 `desktop.json`；根据 `autoLaunch` 决定是否随系统启动。
3. 选择端口、启动子进程、等待健康检查。
4. 创建窗口；如果以 `--hidden` 启动则只显示托盘提示。
5. 写入 `runtime.json`。

### 6.3 窗口与托盘

- 关闭窗口默认隐藏到托盘，不退出；可在托盘取消“关闭时最小化到托盘”。
- 托盘菜单：
  - 打开面板
  - 在浏览器中打开
  - 打开数据目录
  - 打开日志目录
  - 开机自启（勾选项）
  - 退出
- 单实例第二次启动时显示并聚焦窗口。
- 托盘图标与窗口图标使用同一个 `.ico` 资源。

### 6.4 退出

1. 托盘“退出”或系统注销触发 `before-quit`。
2. 向子进程发送 `shutdown` IPC，等待最多 10 秒。
3. 超时则只结束面板子进程（不带 `/T`），Minecraft 进程保持运行。
4. 删除 `runtime.json`，退出 Electron。

### 6.5 开机自启

- 使用 `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`。
- 默认关闭，托盘勾选后立即生效并写入 `desktop.json`。

## 7. 安全

- BrowserWindow：
  - `contextIsolation: true`
  - `sandbox: true`
  - `nodeIntegration: false`
  - `webSecurity: true`
- 只加载 `http://127.0.0.1:<port>`；`will-navigate` 拒绝离开当前 origin。
- `setWindowOpenHandler` 默认拒绝新窗口；`http(s)` 外链交给 `shell.openExternal`。
- `session.setPermissionRequestHandler` 拒绝摄像头、麦克风、定位等未使用权限。
- 服务端继续只绑定 `127.0.0.1`；现有 CSP、CSRF、Host 校验全部保留。
- preload 只暴露最小 API：
  - `openExternal(url)`（仅允许 `http(s)`）
  - `getVersion()`
  - `saveFile({ url, filename })`（桌面下载使用；主进程校验 URL 必须与当前面板
    origin 一致，并禁止跨源重定向）
- 不在日志中输出密码、RCON 密码或会话 token。
- Electron 固定为 `45.0.0`（electron-builder 要求精确版本）；Node 运行时固定为 24。

## 8. 文件传输

- 上传继续走 `<input type="file">` / 拖拽，Electron 原生对话框直接可用。
- 桌面下载优先检测 `window.mcpanelDesktop.saveFile`：通过 preload IPC 调用主进程
  `dialog.showSaveDialog`，主进程用 `session.fetch`（带 Cookie、禁止跨源重定向）
  流式写入 `.part` 文件，成功后 rename 到目标位置；失败时清理 `.part`。
- 浏览器环境继续使用 File System Access API，不支持时回退到 blob 下载。
  禁止把多 GB 备份读入内存。
- 下载保存路径由用户选择；不默认写入安装目录。

## 9. 打包与发布

### 9.1 payload 复用

- `scripts/package-portable.mjs` 继续生成服务器便携包。
- 抽出可复用的 payload 构建函数，桌面构建复用
  `release/mcpanel-<version>-win-x64/`（Node 24 + 服务端生产依赖 + web dist + drizzle）。
- Electron 通过 `extraResources` 把该目录复制到 `resources/server`。
- 桌面壳本身不打包 Node 依赖到 asar；原生模块只在服务端 payload 内。

### 9.2 electron-builder

- `appId: com.ss1uye.mcpanel`
- `productName: MC Panel`
- `win.target`: `nsis` + `portable`
- NSIS：每用户安装、允许选择安装目录、创建桌面/开始菜单快捷方式、
  卸载默认保留 `%APPDATA%\MC Panel`。
- 版本与根 `package.json` 保持一致；tag `v0.4.0` 必须匹配 `0.4.0`。
- 图标使用 `packaging/icon.ico`（256×256），不包含 Minecraft 官方素材。

### 9.3 CI/Release

- 现有 Windows release job 增加：
  1. 构建 server payload；
  2. 构建 `apps/desktop`；
  3. `electron-builder --win nsis portable --x64`；
  4. 运行桌面冒烟（`--smoke-test`：启动子进程、health 通过、退出 0）；
  5. 上传安装包、便携 exe 和 SHA256SUMS。
- GitHub Release 仍使用 `docs/releases/<tag>.md` 作为正文，附件同时包含
  服务器 ZIP 和桌面安装包。
- v0.4.0 不接自动更新；应用内提供“检查更新”链接到 Releases。
- v0.4.x 再接入 `electron-updater`、`latest.yml` 和代码签名。

## 10. 测试

### 10.1 自动化

- 单元测试：
  - 空闲端口选择与失败重试；
  - 子进程参数/环境变量；
  - health 超时与退出码处理；
  - `runtime.json` 孤儿检测；
  - `desktop.json` 默认值与持久化。
- 服务端集成测试：真实启动子进程，验证 health 和 IPC shutdown。
- Playwright Electron 冒烟（Windows）：
  - 启动应用；
  - 等待初始化/登录页可见；
  - 退出并确认子进程结束。
- 现有 server/web/shared 测试和 e2e 全部保留，不因桌面版降级。

### 10.2 手工验收

- 安装包在无 Node 环境的 Windows 10/11 上双击可启动。
- 便携 exe 在可写目录启动，数据落在 exe 旁的 `mcpanel-data`。
- 首次启动导入现有 `data/`，管理员、实例、备份都保留。
- 关窗口进托盘；重复双击只打开一个窗口；托盘退出后子进程结束。
- 开机自启勾选后重启系统生效，以 `--hidden` 启动。
- 启停 Minecraft、控制台、备份创建/下载、恢复、计划任务正常。
- 退出桌面应用后 Minecraft 服务器仍在运行。
- 卸载后用户数据仍保留；重装后可继续使用。
- 文件下载走流式保存；大备份不会导致内存暴涨。

## 11. 里程碑

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| M1 | Electron 壳、ServerProcess、窗口、托盘、单实例、日志 | 2–3 天 |
| M2 | 数据目录/导入/便携模式、自启、孤儿检测、打包脚本 | 2 天 |
| M3 | installer + portable 构建、CI/Release、Playwright 冒烟、文档 | 2 天 |
| v0.4.x | electron-updater、代码签名、原生通知 | 2–3 天 |

## 12. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 安装后约 535MB、安装包约 155MB；便携 exe 每次启动需解压（约 1–2 分钟） | 明确取舍；日常推荐安装版，后续可评估 Tauri 或以 Electron Node 替代自带 Node |
| SmartScreen 提示来源未知 | v0.4.x 代码签名；文档说明从 Releases 下载并校验 SHA256 |
| Electron 崩溃留下面板子进程 | IPC `disconnect` 自动退出 + `runtime.json` 孤儿检测 |
| 强制结束误杀 Minecraft | 只结束面板 pid，不带 `/T`；优先 IPC 优雅退出 |
| 大文件下载进内存 | 优先 File System Access API；回退到原生保存对话框 + 流式写盘 |
| 端口冲突 | 每次启动选择空闲端口，并通过 IPC/窗口 URL 传递 |
| 数据导入覆盖 | 目标非空时提示；不自动删除，只在用户确认后复制 |

## 13. 验收标准

1. 双击安装包或便携 exe 即可进入面板，无需安装 Node/浏览器。
2. 托盘、单实例、开机自启、关闭到托盘、退出清理全部可用。
3. 现有数据可导入，Minecraft 启停/备份/恢复/计划功能与 Web 版一致。
4. 退出桌面应用不停止 Minecraft 服务器。
5. 升级/卸载保留 `data/`，重装后可直接继续使用。
6. 服务端只监听 `127.0.0.1`，窗口只加载本地面板。
7. Windows CI 能构建 installer/portable，并通过桌面冒烟测试。

## 14. 后续（不在 v0.4.0）

- electron-updater 自动更新与回滚；
- 代码签名与 SmartScreen 信誉；
- 原生系统通知（把现有 WS 通知映射到 Windows 通知中心）；
- macOS/Linux 桌面版；
- 桌面设置页（端口、数据目录、更新通道）。
