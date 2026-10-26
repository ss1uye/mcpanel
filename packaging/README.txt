MC Panel {{VERSION}} 便携版
=============================

这是免安装版本，自带 Node.js 运行时，不需要在电脑上安装 Node.js 或 npm。

快速开始
--------
1. 把整个文件夹解压到「有写权限」的目录，例如 D:\MC Panel。
   不要放在 C:\Program Files 下（没有管理员权限时无法写入数据）。
2. 双击 start-panel.bat。
3. 脚本会用 Edge 打开 http://127.0.0.1:3000。
   如果 Edge 没有自动打开，手动在浏览器访问这个地址。
4. 首次打开会进入初始化页面，创建管理员账号。
5. 用面板「纳管实例」添加已有的 Minecraft 服务端目录。

数据与配置
----------
- 数据默认在 data\ 下：panel.db、secret.key、backups\、logs\。
- 端口、监听地址、数据目录可在 .env 中修改；首次启动会自动从 .env.example 复制。
- 修改端口后，请手动打开对应地址（start-panel.bat 会自动读取 .env 中的端口）。
- 关闭启动脚本的黑窗口 = 停止面板；不会停止 Minecraft 服务器。
- 面板默认只监听 127.0.0.1，不要直接把 PANEL_HOST 改成 0.0.0.0。
  需要远程访问请使用 Nginx/Caddy 反向代理，并设置 COOKIE_SECURE=true。

升级
----
1. 先停止面板；
2. 备份 data\ 目录（或在面板里下载面板数据库快照）；
3. 解压新版本到新目录，把旧 data\ 复制过去（或让 .env 指向旧数据目录）；
4. 启动新版本，数据库会自动迁移。

常见问题
--------
- Windows 提示文件来自网络：右键 ZIP → 属性 → 勾选「解除锁定」，再解压。
- 端口被占用：修改 .env 的 PANEL_PORT 后重新启动。
- 忘记管理员密码：停止面板后，在包目录打开命令行执行：
    node\node.exe scripts\reset-password.mjs
  便携包不包含 scripts 目录；可使用源码仓库中的同名脚本，或重新初始化数据目录（会丢失面板数据）。
- 升级前建议用面板的「设置 → 面板数据备份」下载一份 panel.db 快照。

许可证
------
MC Panel 使用 MIT 许可证；Node.js 及其依赖的许可证见 THIRD_PARTY_NOTICES.txt 和 node\LICENSE。
