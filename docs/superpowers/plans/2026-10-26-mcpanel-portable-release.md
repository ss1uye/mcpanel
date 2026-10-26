# MC Panel Windows 便携发版实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出 `mcpanel-0.3.0-win-x64.zip`：内置 Node 24、双击启动、无需系统 Node，附带 SHA256 和 GitHub Release 流水线。

**Architecture:** 在现有 monorepo 构建产物之上，用 `scripts/package-portable.mjs` 组装便携目录；只复制服务端生产依赖树；用 `scripts/smoke-portable.mjs` 解压 ZIP 后真实启动并检查 health/首页/数据文件；CI 在 Windows 上执行打包和冒烟。

**Spec:** `docs/superpowers/specs/2026-10-26-mcpanel-portable-release-design.md`

---

### Task 1: 打包脚本与许可证资产

**Files:**
- Create: `scripts/package-portable.mjs`
- Create: `packaging/start-panel.bat`（模板，打包时复制）
- Create: `packaging/README.txt`（便携版使用说明）
- Create: `packaging/THIRD_PARTY_NOTICES.txt`
- Create: `packaging/licenses/node-LICENSE.txt`（Node 官方许可证）
- Modify: `package.json`（新增 `release:portable`、`smoke:portable`）
- Modify: `.gitignore`（`release/`）

- [ ] 下载 Node 官方 LICENSE 到 `packaging/licenses/node-LICENSE.txt`。
- [ ] 编写 `package-portable.mjs`：
  - 校验 Windows + Node 24 + 构建产物；
  - 复制 `apps/server/dist`、`apps/server/drizzle`、`apps/web/dist`、`package.json`、`apps/server/package.json`、`.env.example`、`LICENSE`、打包模板；
  - `process.execPath` → `node/node.exe`；
  - `npm ls --omit=dev --all --parseable --workspace=@mcpanel/server` → 复制生产依赖（跳过 `@mcpanel` 工作区链接）；
  - `archiver` 的 `ZipArchive` 生成标准 ZIP，Node crypto 生成 `SHA256SUMS.txt`。
- [ ] 编写 `start-panel.bat`：首次复制 `.env.example`、读取 host/port、2 秒后打开 Edge、前台运行内置 node、退出后 pause。
- [ ] 运行 `npm run release:portable`，检查 ZIP 结构与大小，确认无 `.env`/`data/`/测试文件。

### Task 2: 便携包冒烟

**Files:**
- Create: `scripts/smoke-portable.mjs`

- [ ] 用 PowerShell `Expand-Archive` 解压 ZIP 到 `release/smoke/`；
- [ ] 写临时 `.env`（随机端口、`DATA_DIR=./data-smoke`、`PANEL_HOST=127.0.0.1`）；
- [ ] 用包内 `node/node.exe` 启动；
- [ ] 轮询 health、检查 `/` HTML；
- [ ] 停止并检查 `panel.db` / `secret.key`；
- [ ] 清理临时目录。
- [ ] 运行 `npm run smoke:portable`，必须通过。

### Task 3: CI / Release / 密钥扫描

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `.gitleaks.toml`
- Modify: `.github/workflows/ci.yml`

- [ ] release workflow：tag `v*` 或手动触发；Windows 构建、打包、冒烟、上传 artifact；tag 时创建 GitHub Release（ZIP + SHA256SUMS）。
- [ ] CI windows job 在 build 后执行打包与冒烟。
- [ ] gitleaks job（固定版本，全历史）扫描；`.gitleaks.toml` 白名单仅排除已知测试/文档样例。
- [ ] 在本地执行 `node scripts/package-portable.mjs` 与冒烟验证。

### Task 4: 版本、文档与发布

**Files:**
- Modify: `package.json` / `apps/*/package.json` / `packages/shared/package.json` / `packages/shared/src/constants.ts` / `package-lock.json` → 0.3.0
- Create: `CHANGELOG.md`
- Create: `docs/portable.md`
- Modify: `README.md`（下载便携版、启动、升级、数据）
- Modify: `HANDOFF.md`（v0.3 状态、发版命令、已知限制）

- [ ] 升版本到 0.3.0，更新 lockfile。
- [ ] 写文档：下载、解压位置（可写目录）、启动、Edge、数据、升级、迁移旧 data、卸载、Mark-of-the-Web。
- [ ] 更新 HANDOFF 测试基线/发布章节/限制。
- [ ] 最终验证：`npm run typecheck && npm test && npm run lint && npm run build`、
      `npm run release:portable`、`npm run smoke:portable`、`npm run test:e2e`。
- [ ] 提交并推送；创建 `v0.3.0` tag 后在 GitHub Release 上传产物（发布前向用户确认）。

## 自审

- 产物只含运行所需文件；不包含测试/文档/数据/凭据。
- 打包使用当前 Node 24 的 ABI；内置 node.exe 与生产依赖来自同一环境。
- ZIP 解压到可写目录是文档中的硬性前提；默认回环监听。
- 冒烟测试直接验证 ZIP，而不是源目录。
