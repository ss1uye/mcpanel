# 更新日志

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
