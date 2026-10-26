# MC Panel Windows 便携发版设计

> 日期：2026-10-26 · 状态：已确认（仅便携） · 目标版本：v0.3.0

## 1. 目标

让非开发用户在 **Windows x64** 上下载一个 ZIP，解压后双击 `start-panel.bat` 即可使用，
不需要预装 Node.js、npm 或命令行知识。

本期只做便携包，不做安装器、Windows 服务、自动更新、Linux 包或 Docker。后续如需再单独立项。

## 2. 产物

| 文件 | 内容 |
| --- | --- |
| `mcpanel-0.3.0-win-x64.zip` | 完整便携包，顶层目录 `mcpanel-0.3.0-win-x64/` |
| `SHA256SUMS.txt` | ZIP 的 SHA-256 |
| GitHub Release | 发布说明、ZIP、校验和；源码 ZIP 由 GitHub 自动附带 |

包内布局：

```text
mcpanel-0.3.0-win-x64/
├─ start-panel.bat
├─ README.txt                  # 中文使用说明
├─ LICENSE                     # MIT
├─ THIRD_PARTY_NOTICES.txt     # Node 运行时与依赖许可说明
├─ .env.example
├─ package.json                # type=module，版本 0.3.0
├─ node/
│  ├─ node.exe                 # 构建所用 Node 24 运行时
│  └─ LICENSE                  # Node 的许可证
├─ node_modules/               # 仅服务端生产依赖及其传递依赖
├─ apps/
│  ├─ server/dist/index.js
│  ├─ server/drizzle/          # 数据库迁移
│  ├─ server/package.json
│  └─ web/dist/                # 前端构建产物
└─ data/                       # 首次启动自动创建（不预置内容）
```

不包含：源码、测试、e2e、docs、`.git`、`data/`、`secret.key`、`.env`、任何测试密码。

## 3. 启动流程

`start-panel.bat`：

1. `cd /d "%~dp0"`；
2. 如果 `.env` 不存在，从 `.env.example` 复制；
3. 从 `.env` 读取 `PANEL_HOST` / `PANEL_PORT`（默认 `127.0.0.1:3000`）；
4. 后台等待 2 秒后调用 `msedge http://<host>:<port>`；
5. 前台运行 `node\node.exe apps\server\dist\index.js`；
6. 面板退出后 `pause`，让用户看到错误。

- 关闭控制台窗口即停止面板；Minecraft 服务器不会被自动停止（与现有行为一致）。
- 默认只监听 `127.0.0.1`；不要直接把 `PANEL_HOST` 改成 `0.0.0.0`，远程访问应使用反向代理。
- 数据目录默认是包内 `./data`，因此必须解压到有写权限的目录（如 `D:\MC Panel`），
  不要放在 `C:\Program Files` 下。

## 4. 打包脚本

`scripts/package-portable.mjs`（Windows 专用）：

1. 校验 `process.platform === 'win32'` 且 Node major 为 24；
2. 校验 `apps/server/dist/index.js`、`apps/web/dist/index.html`、`apps/server/drizzle` 存在；
3. 清理并创建 `release/mcpanel-<version>-win-x64/`；
4. 复制运行产物、`.env.example`、`LICENSE`、`start-panel.bat`、README/第三方声明；
5. 复制 `process.execPath` 为 `node/node.exe`，复制 Node LICENSE；
6. 通过 `npm ls --omit=dev --all --parseable --workspace=@mcpanel/server` 找出服务端生产依赖，
   跳过 `@mcpanel/*` 工作区链接，按相对 `node_modules` 路径复制；
7. 用 PowerShell `Compress-Archive` 生成 ZIP（避免 PATH 中的 tar 实现差异）；
8. 用 Node `crypto` 生成 `SHA256SUMS.txt`；
9. 打印 ZIP 路径与大小。

npm 脚本：`npm run release:portable` = `npm run build && node scripts/package-portable.mjs`。

## 5. 冒烟测试

`scripts/smoke-portable.mjs`：

1. 用 PowerShell `Expand-Archive` 解压生成的 ZIP 到 `release/smoke/`；
2. 写入临时 `.env`（随机端口、`DATA_DIR=./data-smoke`、`PANEL_HOST=127.0.0.1`）；
3. 用包内 `node/node.exe` 启动 `apps/server/dist/index.js`；
4. 轮询 `/api/health`，断言 `ok: true` 且版本为当前版本；
5. 请求 `/`，断言返回 HTML 且包含 `MC Panel`；
6. 停止进程，断言 `data-smoke/panel.db` 与 `secret.key` 已创建；
7. 清理临时目录。

CI 在 `windows-latest` 上执行该冒烟；本地也可运行。

## 6. 发布流水线

`.github/workflows/release.yml`：

- 触发：`v*` tag 或手动 `workflow_dispatch`；
- `windows-latest`：checkout、Node 24、npm 11.19.1、`npm ci`、typecheck/test/lint/build、
  `npm run release:portable`、`npm run smoke:portable`；
- 上传 artifact；tag 触发时用 `softprops/action-gh-release` 创建 Release，
  附件为 ZIP 与 SHA256SUMS；
- 版本必须与 `package.json` / `PANEL_VERSION` 一致，不一致直接失败；
- 预留代码签名步骤（证书未提供时不执行）。

现有 `.github/workflows/ci.yml` 增加：
- 在 windows 矩阵的 build 之后执行便携打包与冒烟（防止打包脚本腐烂）；
- `secret-scan` job：下载固定版本 gitleaks，扫描全历史；测试/文档中的已知测试凭据通过
  `.gitleaks.toml` 白名单排除。

## 7. 文档与版本

- 版本升至 `0.3.0`（根/工作区 package.json、lockfile、`PANEL_VERSION`）。
- `README.md` 增加「下载便携版」章节：Release 链接、解压位置、启动、Edge、
  数据位置、升级、备份、防火墙/反代、常见问题。
- `docs/portable.md`：详细使用、升级、迁移现有 `data/`、关闭控制台行为、卸载（删目录前备份）。
- `CHANGELOG.md`：0.3.0 变更。
- `HANDOFF.md`：发布状态、发版命令、已知限制（便携无服务/无自动更新、ZIP 可能被
  Mark-of-the-Web 标记、需手动解压到可写目录）。

## 8. 安全

- 便携包不包含 `.env`、`secret.key`、`data/` 或任何真实凭据；
- 运行身份是当前 Windows 用户，不创建服务、不提升权限；
- 默认仅回环监听；首次初始化管理员；
- ZIP 未签名，浏览器/Windows 可能提示来源未知；文档说明“属性 → 解除锁定”，
  后续可接入代码签名；
- 发布 CI 跑 gitleaks；仓库现有测试密码仅用于临时 e2e 数据目录，不属于生产凭据。

## 9. 验收标准

- [ ] `npm run release:portable` 生成 ZIP 与 SHA256SUMS；
- [ ] ZIP 解压后无源码/测试/凭据，包含内置 Node 与全部运行依赖；
- [ ] `start-panel.bat` 在无系统 Node 的环境也能启动（使用包内 node）；
- [ ] 冒烟脚本通过：health、首页 HTML、data/panel.db、secret.key；
- [ ] Windows CI 的打包与冒烟通过；release workflow 可手动预演；
- [ ] 文档覆盖下载、启动、升级、数据迁移、卸载与安全注意事项；
- [ ] gitleaks 在 CI 中通过。

## 10. 非目标

Windows 安装器/服务、自动更新、代码签名、Linux 包、Docker、桌面壳、安装器 UI。
