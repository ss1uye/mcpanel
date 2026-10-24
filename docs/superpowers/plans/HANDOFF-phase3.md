# 阶段 3 执行交接（进行中）

> 目的：上下文压缩后凭本文档继续执行，无需重新探索。
> 最后更新：阶段 3 全部任务与代码审查修复完成后（`main` 分支，HEAD `f9f60e1`）。

## 基本事实

- 计划：`docs/superpowers/plans/2026-10-24-minecraft-panel-phase3-backups-schedules-deploy.md`（15 个任务，含完整代码）
- 分支：`main`；无 remote；阶段 2 收尾提交为 `37fd975`
- 基线：`npm run typecheck` 0 错误；`npm test` = server 206 / web 45 / shared 11；`npm run lint` 干净；`npm run build` 通过；`npm run test:e2e` 通过

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
| Task 10 备份页签前端 | ✅ | `2a6a84e` |
| Task 11 计划页签前端 | ✅ | `c5c311f` |
| Task 12 恢复残留警告与清理 | ✅ | `6d89de6` |
| Task 13 Playwright 冒烟 | ✅ | `46cd995` |
| Task 14 部署脚本/改密/文档 | ✅ | `ba18839` |
| Task 15 验收与收尾 | ✅ | `7e6a09a` + 审查修复 `f9f60e1` |

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

## 代码审查结果（已处理）

独立审查复现了两个 Critical 并已修复（提交 `f9f60e1`）：

1. **恢复可写出实例根目录**：构造 `sources: ["../victim"]` 的 manifest 可把文件移出根目录；`plugins` 为 junction 时可覆盖外部目录。修复：`validateManifest` 拒绝 `..`/反斜杠/绝对路径/`.mcpanel-tmp` 与非法 `totalBytes`；每个源路径与临时目录都经 `PathSandbox.resolve`；`.mcpanel-tmp` 组件被检查。新增 `restore-safety.test.ts`（5 例：穿越、反斜杠、junction、忙碌/残留、恢复中被启动）。
2. **恢复期间可启动服务器**：备份/恢复改用 `InstanceSupervisor.runExclusive` 的实例锁，与启动/停止/重启共用；`preflight`/`startCreate` 用同步 `assertIdle` 返回 409；恢复在交换前再次检查 `stopped`；UI 在任务运行时禁用启停按钮。
3. 其他修复：移动失败也回滚并记录失败路径；重试恢复不再删除非空 rollback；§12.6 启动恢复（非空 rollback → 实例 `unknown` + 错误，空目录清理）；pre_restore 不再提前结束恢复任务；删除实例先停计划任务再删行；空目录纳入归档并可恢复；`level-name`/额外路径经沙箱校验；zip 解压按实际字节计数；`.part`/失败备份可删除；`TaskTracker.cleanup` 定时执行；下载与定时运行/定时命令补审计；`reset-password` 读取 `.env`；计划支持独立时区输入与“上次运行”展示。

## 已知遗留（可接受）

- 备份 manifest 只做结构与路径校验，未与数据库存证做哈希比对（面板自己生成的备份可信；手工替换 zip 仍会被路径校验挡住）。
- 运行中备份与“面板之外的进程终止”仍存在窄竞态（面板内的启停已被锁串行化）。
- 备份下载未校验状态字段，失败记录下载会得到 404/500。
- Playwright 只覆盖冷备份路径与 375px 概览页，计划/清理/失败恢复由集成测试覆盖。

## 下一步

第一版（阶段 1–3）交付完成。后续可选：远程节点 Agent、告警/通知、多用户与权限、面板自身数据库的在线备份脚本。
