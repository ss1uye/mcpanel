# 阶段 3 执行交接（进行中）

> 目的：上下文压缩后凭本文档继续执行，无需重新探索。
> 最后更新：后端 9 个任务全部完成后（`main` 分支，HEAD `ab63d55`）。

## 基本事实

- 计划：`docs/superpowers/plans/2026-10-24-minecraft-panel-phase3-backups-schedules-deploy.md`（15 个任务，含完整代码）
- 分支：`main`；无 remote；阶段 2 收尾提交为 `37fd975`
- 基线：`npm run typecheck` 0 错误；`npm test` = server 195 / web 37 / shared 11；`npm run lint` 干净

## 任务进度

| 计划任务 | 状态 | 提交 |
| --- | --- | --- |
| Task 1 共享契约（备份/计划/任务） | ✅ | `22bd269` |
| Task 2 备份源规划 | ✅ | `0ed7bf4` |
| Task 3 安全解压与备份打包 | ✅ | `3e46e29` |
| Task 4 严格一致性冻结 | ✅ | `02bb55c`、`13f0935` |
| Task 5 BackupService | ✅ | `aac000f` |
| Task 6 RestoreService | ✅ | `544dc9f` |
| Task 7 备份路由 + 任务频道 + 残留清理 | ✅ | `0747272` |
| Task 8 ScheduleService | ✅ | `a472f7d` |
| Task 9 计划路由与调度器 | ✅ | `ab63d55` |
| Task 10 备份页签前端 | ⏳ 下一个 | — |
| Task 11 计划页签前端 | ⏳ | — |
| Task 12 恢复残留警告与清理 | ⏳ | — |
| Task 13 Playwright 冒烟 | ⏳ | — |
| Task 14 部署脚本/改密/文档 | ⏳ | — |
| Task 15 验收与收尾 | ⏳ | — |

## 执行中的偏差（已落地，以代码为准）

1. `archiver` 安装到的是 **8.x**，不再导出可调用默认值；必须 `import { ZipArchive } from 'archiver'` 并 `new ZipArchive({ zlib })`。计划文本已同步。
2. `extractZipSafe` 增加可选 `resolveTarget(entryName)`：文件页解压时仍逐条走 `PathSandbox.resolve`（防止目标目录内已有符号链接被利用），恢复流程用默认路径。
3. `fake-rcon.mjs` 新增 `logFile` 选项：`save-all flush` 在延迟后向该文件追加 `Saved the game` 并回包；未传 `logFile` 时保留原「延迟即不响应」语义，避免破坏既有 RCON 测试。`fake-rcon.d.mts` 已同步。
4. 备份源为空时使用 `VALIDATION_ERROR`（计划最初写的是 `BACKUP_REQUIRES_STOP_OR_RCON`，语义不对）。
5. `BackupService` 不注入 `AuditService`；审计在路由层记录（`backup.create/delete`），计划里的 deps 列表以此为准。
6. 解压/打包的测试共用 `test/helpers/zip.ts` 的 `makeZip`（注意 `0o100644 << 16` 需 `>>> 0`，否则 `writeUInt32LE` 抛 RangeError）。
7. `RestoreService` 采用 **preflight + start**：`preflight()` 同步校验备份存在/ready/实例停止/manifest/磁盘，路由据此返回 409；`start()` 只负责后台任务。计划里「start 直接 reject」的测试已改为对 `preflight` 断言。
8. `ScheduleService` 的 deps 不再含 `defaultTimezone`；默认时区由计划路由从 `SettingsService` 注入（`POST` 未带 timezone 时补齐）。
9. WS 任务频道：订阅不存在的任务返回 `NOT_FOUND`；测试里 `TestSocket.send` 接受对象（内部 JSON.stringify），不要重复 stringify，否则会得到 `VALIDATION_ERROR`。
10. 计划服务测试比计划多两条：运行中命令成功、每次裁剪到 100 条运行记录。

## 继续方式

从 Task 10（备份页签前端）开始按计划执行。后端接口已全部就绪：备份/恢复/任务 WS/计划 CRUD/立即运行/运行记录/恢复残留清理。若计划与已提交代码冲突，以代码为准并同步修正计划文本。
