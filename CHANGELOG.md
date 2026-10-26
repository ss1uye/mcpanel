# 更新日志

## 0.4.0 - 2026-10-27

### 新增

- Windows 桌面版（Electron）：原生窗口、系统托盘、单实例、开机自启、关闭窗口最小化到托盘；面板服务作为子进程运行，退出桌面应用不会停止 Minecraft 服务器。
- NSIS 每用户安装器 + 便携 exe；首次启动支持导入现有 `data/`；安装版数据在 `%APPDATA%\MC Panel`，便携版在 exe 旁 `mcpanel-data/`。
- 桌面下载桥：大文件走主进程流式保存；RCON 密码可复制到剪贴板；权限请求默认拒绝。
- 发布流水线同时构建服务器便携 ZIP 和桌面安装包；新增桌面 Playwright 冒烟与隔离打包冒烟。

### 修复

- 便携版开机自启指向真实便携 exe，而不是临时解压路径。
- 孤儿检测在 PID 存活但健康检查失败时保留 `runtime.json` 并阻止双开；增加端口探活避免 PID 复用误锁。
- 数据导入改为 staging + rename 原子发布，拒绝非空目标和路径包含。
- 下载使用 `.part` 临时文件并禁止跨源重定向；退出清理无论异常都执行 `app.exit`。

### 升级

- 无数据库结构变更；安装版直接覆盖安装，便携版替换程序并保留 `mcpanel-data/` 或导入旧 `data/`。
- 0.4.0 不含自动更新和代码签名；新版本需手动从 Releases 下载。

## 0.3.1 - 2026-10-26

### 优化

- 控制台日志按 60ms 批量推送，前端按 seq 增量去重；缓冲区改为批量裁剪，降低模组服启动时的 WebSocket 帧与 React 渲染压力。
- 系统指标改用 Node 原生 `os.*` 计算，避免 Windows 上每 3 秒拉起 systeminformation/PowerShell；实例指标并行采样并共享进程枚举；系统概览接口复用 5 秒内的采样，避免与 WebSocket 重复采样。
- 备份一次遍历同时生成文件清单与压缩包，运行中备份在 `save-all` 冻结后规划；文件列表按 64 个一批并发 stat。
- 用轻量 SVG 替换 recharts，移除约 314 kB 的 charts 分包。
- 玩家列表只在服务器运行/孤儿状态轮询，右侧面板在玩家页不重复轮询。
- `server.properties` 解析按 mtime/ctime/size 缓存，面板写入后立即失效。
- 实例删除改为异步清理备份目录，避免大目录阻塞事件循环。
- WS 客户端增加心跳看门狗，75 秒无收包自动关闭并重连。
- 共享包增加 `./constants` 子路径，web 首屏不再打包 zod/schemas（`index` 258.5 → 161.0 kB）。

### 修复

- 任务清理不再删除仍在运行的任务，大世界备份超过 1 小时时 UI 不再丢失进度。

### 安全

- 升级 `@fastify/static` 10.1.7、`drizzle-orm` 0.45.4、`zod` 4.6.7，修复 3 个 high 漏洞；CI 增加生产依赖审计。

### 升级

- 无数据库结构变更；便携版替换程序并保留 `data/`，源码部署保留现有 `data/` 后重新 `npm ci && npm run build`。

## 0.3.0 - 2026-10-26

### 新增

- Windows x64 便携版 `mcpanel-0.3.0-win-x64.zip`：内置 Node 24，无需安装 Node/npm，解压后双击 `start-panel.bat` 即可运行。
- 便携包附带 SHA-256 校验和、Node 许可证、使用说明；数据默认保存在包内 `data/`。
- GitHub Actions 发布流水线：tag `v*` 自动构建、冒烟、创建 Release 并上传便携包与校验和。
- CI 增加便携打包/冒烟和 gitleaks 密钥扫描。
- `docs/portable.md` 便携版下载、启动、升级、数据迁移与排障说明。

### 修复

- 指标采样失败（如 Windows `EBUSY`）不再触发面板级 unhandledRejection，单次失败只记录日志并跳过。
- 实例「Java 路径」现在会真正应用到启动环境（PATH/JAVA_HOME）；启动阶段遇到 Java/Mixin 版本不兼容会自动结束残留启动器并标记 crashed。
- POSIX 下裸 `start.sh` / `run.sh` 从实例根目录解析，避免 `command not found`。
- 恢复流程测试容忍目录交换瞬间的文件缺失。

### 升级

- 无数据库结构变更，可直接替换程序文件并保留 `data/`。
- 现有源码部署可继续使用 `npm run build && npm start`。

## 0.2.0 - 2026-10-24

- CSP 每请求 nonce，WebSocket 仅允许当前 Host；面板数据库在线快照；备份下载校验；计划未来 3 次运行预览；CodeMirror 6 编辑器；路由懒加载与分包。
