# Windows 便携版

> 适用于 Windows 10/11 x64。无需安装 Node.js、npm 或数据库。
>
> 如果你想要桌面应用，请优先使用 Releases 中的 `MC-Panel-Setup-0.4.0.exe` 或
> `MC-Panel-0.4.0-portable.exe`。本文档下面的 ZIP 是服务器便携版（双击
> `start-panel.bat`，用浏览器打开）。

## 下载

从 [GitHub Releases](https://github.com/ss1uye/mcpanel/releases/latest) 下载：

- `mcpanel-0.4.0-win-x64.zip`
- `SHA256SUMS.txt`（可选，用于校验）

## 解压与启动

1. 把 ZIP 解压到**有写权限**的目录，例如 `D:\MC Panel`。
   不要解压到 `C:\Program Files`，否则普通用户无法写入 `data/`。
2. 如果 Windows 提示文件来自网络，先右键 ZIP → 属性 → 勾选「解除锁定」，再解压。
3. 双击 `start-panel.bat`。
4. 脚本会在 2 秒后打开 Edge，访问 `http://127.0.0.1:3000`。
   如果没有自动打开，手动在 Edge 输入该地址。
5. 首次打开进入初始化页面，创建管理员账号。

`start-panel.bat` 使用包内 `node\node.exe`，不读取系统 PATH 中的 Node。
关闭这个黑窗口即停止面板；**不会停止 Minecraft 服务器**。

## 数据与配置

```text
mcpanel-0.4.0-win-x64/
├─ start-panel.bat
├─ .env                  # 首次启动从 .env.example 复制
├─ data/
│  ├─ panel.db
│  ├─ secret.key
│  ├─ backups/
│  └─ logs/
├─ node/
├─ node_modules/
└─ apps/
```

- 修改端口/监听地址：编辑 `.env` 后重启 `start-panel.bat`。
- 默认只监听 `127.0.0.1`。不要直接把 `PANEL_HOST` 改成 `0.0.0.0`；
  远程访问请用 Nginx/Caddy 反向代理，并设置 `COOKIE_SECURE=true`、`TRUST_PROXY=true`。
- 数据目录可改为绝对路径（`DATA_DIR=D:\mcpanel-data`），便于升级和备份。
- 建议定期在「设置 → 面板数据备份」下载 `panel.db` 快照。

## 升级

1. 停止面板（关闭黑窗口）；
2. 备份 `data/` 或在面板下载数据库快照；
3. 解压新版本到新目录；
4. 把旧 `data/` 复制到新目录（或在 `.env` 里把 `DATA_DIR` 指向旧数据目录）；
5. 启动新版本，数据库迁移会自动执行。

便携版没有自动更新，也没有 Windows 服务；需要开机自启时，可自行把 `start-panel.bat`
的快捷方式放入「启动」文件夹。

## 从源码部署迁移

如果之前用源码运行（`npm run build && npm start`）：

1. 停止源码面板；
2. 把源码目录的 `data/` 复制到便携包目录；
3. 启动便携版即可。

管理员、审计、实例注册和备份都会保留。

## 忘记管理员密码

停止面板，在包目录打开命令行：

```bat
node\node.exe scripts\reset-password.mjs admin
```

按提示输入两次新密码；会清空所有会话，不影响实例和备份。

## 卸载

停止面板后直接删除整个文件夹即可。删除前请备份 `data/`；Minecraft 服务器目录不在包内，
不会被删除。

## 安全与限制

- ZIP 未签名，Windows/浏览器可能提示来源未知；请从本仓库的 Releases 下载并核对 SHA256。
- 便携版以当前 Windows 用户身份运行，不提升权限，不注册服务。
- 没有自动启动、自动更新、服务守护；关闭控制台即停止面板。
- 包体积约 55 MB（内置 Node 24 和运行依赖）。
- 包内不包含源码、测试、`.env`、`secret.key` 或任何真实凭据。
