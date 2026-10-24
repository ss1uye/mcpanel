# 阶段 4（v0.2 打磨与加固）收尾

> 日期：2026-10-24 · 版本：v0.2.0 · 分支：`main`
> 规格：`docs/superpowers/specs/2026-10-24-mcpanel-v0.2-design.md`
> 计划：`docs/superpowers/plans/2026-10-24-mcpanel-v0.2-polish.md`

## 1. 交付内容

| 能力 | 关键文件 |
| --- | --- |
| CSP 每请求 nonce、Host 限定 connect-src | `apps/server/src/app.ts`、`apps/web/index.html`、`apps/web/src/utils/csp.ts` |
| 面板数据库在线快照 + 下载接口 | `apps/server/src/services/panel-backup-service.ts`、`apps/server/src/routes/settings.ts`、`scripts/backup-panel-db.mjs` |
| 备份下载校验与真实文件名 | `apps/server/src/services/backup-service.ts`、`apps/server/src/routes/backups.ts` |
| 计划未来 3 次运行 + 表单预览 | `apps/server/src/services/schedule-service.ts`、`apps/server/src/routes/schedules.ts`、`apps/web/src/components/ScheduleForm.tsx` |
| CodeMirror 6 编辑器（按需加载） | `apps/web/src/components/CodeEditor.tsx`、`apps/web/src/utils/editor-language.ts` |
| 路由懒加载与 vendor 分包 | `apps/web/src/router.tsx`、`apps/web/vite.config.ts` |
| e2e 覆盖 | `e2e/smoke.spec.ts` |

无数据库 schema/迁移变更，v0.1 数据可直接升级。

## 2. 关键决策

- **CSP nonce**：服务端启动时读取构建后的 `index.html` 模板，按请求替换 `__CSP_NONCE__` 并 `Cache-Control: no-store`；`@fastify/static` 关闭 `index`，`/`、`/index.html` 与 SPA fallback 共用渲染函数。
- **动态样式 nonce**：CodeMirror 使用 `EditorView.cspNonce`；Radix 依赖 `react-style-singleton` 通过 `get-nonce` 读取 `__webpack_nonce__`，因此 `main.tsx` 在启动时把 meta nonce 写入该全局变量。
- **反向代理**：`TRUST_PROXY=true` 时 CSP 优先使用 `X-Forwarded-Host`，避免代理改写 Host 后 WebSocket 被拦截。
- **面板快照**：better-sqlite3 `backup()` 在 WAL 下生成一致性快照，写入 `data/tmp/`，读流 `close` 后删除；文件名 UTC 时间戳，同秒冲突追加随机后缀。
- **计划预览**：`nextRunsFor` 复用 croner 的 `paused` 实例；列表接口直接返回 `nextRuns`，表单用 300ms 防抖调用预览接口，非法表达式不阻止编辑但保存仍由后端兜底。
- **分包**：Vite 8 的 `manualChunks` 仅接受函数；react/react-dom/react-router 与 recharts 单独成 chunk，CodeMirror 由动态导入自动分包；关闭 modulepreload polyfill 以保持 `script-src 'self'`。

## 3. 验证结果

- `npm run typecheck`：通过。
- `npm test`：server 212、web 49、shared 12。
- `npm run lint`：通过。
- `npm run build`：通过；`index` 221.6 kB（gzip 66.2）、`react` 246.4 kB（gzip 78.6）、`charts` 314.1 kB、`CodeEditor` 437.0 kB（后两者按需加载）。
- `npm run test:e2e`：通过；断言生产构建下无 CSP 违规，CodeMirror 可编辑保存，面板库快照可下载。
- GitHub Actions：ubuntu-latest 与 windows-latest 均通过（首轮 v0.1 CI 与本次 v0.2 推送）。

## 4. 偏差与补充

- 计划中的 `ScheduleForm` 预览测试额外在 `beforeEach` 里给 `api.get` 设置了 `{ nextRuns: [] }`，避免 React Query 对 `undefined` 数据的告警。
- 文档收尾时发现反向代理 Host 风险，补充了 `X-Forwarded-Host` 处理与单元测试（计划外但属于 CSP 设计范围）。
- `editor-language` 只做纯函数测试；CodeMirror 本身由 Playwright 在生产构建下验证。

## 5. 遗留风险

1. 备份 manifest 未做哈希存证（v0.1 限制保留）。
2. 运行中备份与面板外进程终止存在窄竞态（保留）。
3. 反向代理需转发 `Host` 或 `X-Forwarded-Host`，否则 WebSocket 会被 CSP 拦截（已写入 README/HANDOFF）。
4. 面板库快照仅含 `panel.db`，恢复需停面板手工替换，`.env`/`secret.key` 单独保存。

## 6. 回退

每个能力为独立提交，可按需 `git revert`：
CSP、面板快照、下载校验、计划预览、CodeMirror、路由分包、nonce 全局传播、e2e、文档版本各一组提交。
