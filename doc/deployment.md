# 服务器部署指南

本项目设计为**单实例常驻的 Node.js 24 服务 + 本地 SQLite + systemd 定时器**。网页登录会话、接口限流和企业微信消息去重缓存在进程内存中，不支持 Serverless 或多副本横向扩容。

下面以专用低权限用户 `ucas`、代码目录 `/opt/ucas-autosign-bot` 为例说明部署步骤（可按实际路径调整 `systemd` 单元文件）。

## 1. 准备运行环境与目录

确保服务器已安装 **Node.js 24**（内置 `node:sqlite`）及反向代理（如 Nginx、OpenResty 或 Caddy）。

```sh
# 创建专用系统用户
sudo useradd --system --create-home --shell /usr/sbin/nologin ucas

# 拉取代码并安装依赖
sudo install -d -o ucas -g ucas -m 0700 /opt/ucas-autosign-bot
sudo -u ucas git clone https://github.com/Z2U35/UCAS-AutoSign-Bot.git /opt/ucas-autosign-bot
cd /opt/ucas-autosign-bot
sudo -u ucas npm ci
sudo -u ucas npm run build
```

准备 SQLite 数据目录与机器密钥目录（权限必须严格设为 `0700`）：

```sh
sudo install -d -o ucas -g ucas -m 0700 /var/lib/ucas-signin
sudo install -d -o root -g ucas -m 0750 /etc/ucas-signin
sudo install -d -o ucas -g ucas -m 0700 /etc/ucas-signin/keys
```

## 2. 初始化私有配置

在线上 HTTPS 环境初始化时**不要**带 `--local-http`（默认开启 `secureCookies: true`）：

```sh
cd /opt/ucas-autosign-bot
sudo -u ucas node scripts/setup-access.mjs
```

执行后会以 `0600` 权限生成 `config/private.json` 和 `config/access-password.txt`。把 `access-password.txt` 里的随机访问密码保存到密码管理器后，立即删除该明文文件：

```sh
sudo rm -f /opt/ucas-autosign-bot/config/access-password.txt
```

参照 [`config/example.json`](../config/example.json) 编辑 `/opt/ucas-autosign-bot/config/private.json`：

- 保留脚本生成的 `access` 对象（后续需要轮换网页口令时运行 `sudo -u ucas node scripts/setup-access.mjs --rotate`，不会清空学生配置）。
- 填入 `studentPassword`（iClass 学生端登录密码）。
- 在 `students` 数组中填写授权账号（`id` 唯一，`name` 为字母开头的英文别名，`studentId` 为 15 位数字字符串，可选绑定 `wecomUserId`）。
- 如需企业微信推送与微信 `/` 指令交互，填写 `wecom` 配置块。

`config/private.json` 在每次请求时按需读取，日常增删学生或修改 `wecom` 字段保存即生效，无需重启服务。

## 3. 生成定时调度密钥与环境变量

`systemd` 定时器通过本机回环接口 `/api/internal/auto-sign/tick` 驱动任务执行，使用 32 字节随机机器密钥鉴权：

```sh
sudo -u ucas node /opt/ucas-autosign-bot/scripts/setup-auto-sign.mjs \
  --key-file /etc/ucas-signin/keys/auto-sign.key
```

创建 `/etc/ucas-signin/auto-sign.env`（权限 `0640`，属组 `ucas`）：

```ini
UCAS_AUTO_SIGN_URL=http://127.0.0.1:3000/api/internal/auto-sign/tick
UCAS_AUTO_SIGN_DB_PATH=/var/lib/ucas-signin/auto-sign.sqlite
UCAS_AUTO_SIGN_KEY_FILE=/etc/ucas-signin/keys/auto-sign.key
# 初次部署建议先保持 dry-run 演练，确认调度正常后再改为 live
UCAS_AUTO_SIGN_MODE=dry-run
```

设置文件权限：

```sh
sudo chown root:ucas /etc/ucas-signin/auto-sign.env
sudo chmod 0640 /etc/ucas-signin/auto-sign.env
```

## 4. 安装 systemd 服务与定时器

将 [`scripts/`](../scripts/) 下的模板复制到 `/etc/systemd/system/`（若 Node.js 路径或监听端口不同，先按实际环境修改或添加 `override.conf`）：

```sh
sudo cp /opt/ucas-autosign-bot/scripts/ucas-signin.service /etc/systemd/system/
sudo cp /opt/ucas-autosign-bot/scripts/ucas-auto-sign.service /etc/systemd/system/
sudo cp /opt/ucas-autosign-bot/scripts/ucas-auto-sign.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now ucas-signin.service
sudo systemctl enable --now ucas-auto-sign.timer
```

检查运行状态：

```sh
systemctl status ucas-signin.service ucas-auto-sign.timer
```

确认 `dry-run` 演练无误后，将 `/etc/ucas-signin/auto-sign.env` 中的 `UCAS_AUTO_SIGN_MODE` 改为 `live`，并重启 `ucas-signin.service` 即可正式启用自动签到。

## 5. HTTPS 反向代理

Node.js 进程仅监听本机 `127.0.0.1:3000`，公网入口必须通过反向代理开启 HTTPS（否则 `Secure` 会话 Cookie 无法写入，且企业微信回调要求公网可访问域名）：

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    # SSL 证书配置略

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

如果启用了企业微信自建应用，在反代生效后：
1. 在企业微信后台「API 接收消息」填写 `https://example.com/api/wecom/callback` 完成验证；
2. 将服务器出口公网 IP 填入「企业可信 IP」；
3. 运行 `sudo -u ucas node scripts/test-wecom.mjs` 验证推送连通性。

## 6. 日常更新与备份

不要直接在运行中的工作目录里执行 `npm run build` 覆盖正在提供服务的 `.next` 目录。推荐在同一文件系统的临时目录完成构建与离线测试后再原子替换：

```sh
STAGE=/var/lib/ucas-signin/staging-build
sudo -u ucas rm -rf "$STAGE"
sudo -u ucas install -d -m 0700 "$STAGE"

cd /opt/ucas-autosign-bot
sudo -u ucas git pull --ff-only
sudo -u ucas sh -c "git archive --format=tar HEAD | tar -xf - -C \"$STAGE\""
sudo -u ucas cp -al /opt/ucas-autosign-bot/node_modules "$STAGE/node_modules"

cd "$STAGE"
sudo -u ucas npm run lint
sudo -u ucas npm run test:auto-sign
sudo -u ucas npm run build
sudo -u ucas node scripts/test-access.mjs

sudo -u ucas rm -rf "$STAGE/.next/cache" /opt/ucas-autosign-bot/.next.prev
sudo -u ucas mv /opt/ucas-autosign-bot/.next /opt/ucas-autosign-bot/.next.prev
sudo -u ucas mv "$STAGE/.next" /opt/ucas-autosign-bot/.next
sudo -u ucas rm -rf /opt/ucas-autosign-bot/.next.prev "$STAGE"

sudo systemctl restart ucas-signin.service
```

如需在升级前备份 WAL 模式的 SQLite 数据库，使用在线备份接口（不要直接 `cp` 正在写入的 `.sqlite` 文件）：

```sh
sudo -u ucas python3 -c "
import sqlite3
src = sqlite3.connect(\"/var/lib/ucas-signin/auto-sign.sqlite\")
dst = sqlite3.connect(\"/var/lib/ucas-signin/auto-sign.backup.sqlite\")
src.backup(dst)
dst.close()
src.close()
"
sudo chmod 0600 /var/lib/ucas-signin/auto-sign.backup.sqlite
```
