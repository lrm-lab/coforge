# 在 production 上启用云电脑

一套 production 只绑定一个 Swarm。本机管理节点是 `10.110.158.147`（与 Compose 里的桌面代理地址一致）。通用约定在 [对接 Swarm](README.md)；staging 对照见 [在 staging 上启用云电脑](staging-bring-up.md)。

生产 Web 的运行时密钥在 ECS 主机目录 `~/coforge-production/infra/production/secrets/`，**不靠** GitHub Environment 同步（见 [production README](../production/README.md)）。

设置里的「云电脑服务」在核对操作密码之后，可以下载管理节点安装脚本。操作密码是 Web 的 `COFORGE_CLOUD_SERVICE_PASSWORD`（写在 secrets 目录同名小写文件里），6 到 200 个字符。没设时这一页停在密码输入。

## 令牌与操作密码

在受控环境生成一次（不要贴进聊天、工单或仓库）：

```sh
openssl rand -hex 32   # → coforge_cloud_cluster_token
openssl rand -hex 16   # → coforge_cloud_service_password（示例长度；可自定 6–200）
```

同一份集群令牌明文放两处：

1. 生产 ECS：`~/coforge-production/infra/production/secrets/coforge_cloud_cluster_token`（mode `600`）
2. 本机管理节点：`~/.coforge-host/host.env` 的 `COFORGE_CLUSTER_TOKEN`

可选：同目录写入 `coforge_cloud_service_password`，部署后传入 Web，才能打开「云电脑服务」页下载 bootstrap。

服务端只保存令牌哈希。两处不一致时注册被拒绝（`invalid host token`）。不要生成第二把，也不要把明文写进 git、镜像层或日志。

## 部署 Web（带上云电脑变量）

确认 `infra/production/docker-compose.yml` 已含 `COFORGE_CLOUD_CLUSTER_TOKEN`、桌面 origin、以及 Caddy 的 `COFORGE_DESKTOP_UPSTREAM`（指向 `10.110.158.147:6090`）。把上述 secret 文件写好后，走现有 **Deploy Web (production)** 流程，把 Compose/Caddy 资产推到 ECS。空令牌时云电脑保持关闭，部署仍可成功。

## Computer 与电脑镜像

生产 feed：`https://releases.coforge.cn`（当前 `latest` 须带 `host` 子命令，且编译绑定 `https://coforge.cn`）。

电脑镜像在 `create_docker_image_for_pi`：

```sh
cp config/coforge.env.example config/coforge.env
# COFORGE_ENV=production
./scripts/build-swarm.sh
```

得到本机标签 `coforge-computer:production`。`host` 使用 `--no-resolve-image`，节点上没有该标签时不会去仓库拉。本 Swarm 只有这一台管理节点时，镜像就构建在这台机器上。

## 准备 Swarm（本机）

```bash
docker swarm init --advertise-addr 10.110.158.147
docker node ls   # 应有 Ready 节点
```

用户须在 `docker` 组。

## 启动 host

可用「云电脑服务」页下载的 `coforge-host-bootstrap.sh`（需已配置操作密码），或手动：

```
# ~/.coforge-host/host.env （600）
COFORGE_CLUSTER_TOKEN=<与生产 secrets 相同的明文>
COFORGE_CLUSTER_NODE_KEY=<openssl rand -hex 32，只生成一次>
COFORGE_CLUSTER_NAME=production
COFORGE_COMPUTER_IMAGE=coforge-computer:production
```

二进制放在 `~/.coforge-host/coforge-computer`（从 `https://releases.coforge.cn` 的当前 `linux-x64` 安装），系统服务：

```
ExecStart=/home/<用户>/.coforge-host/coforge-computer host --server-url https://coforge.cn
```

以拥有 `host.env` 的用户运行，并加入 `docker` 组；用 **系统** unit，不要用用户服务。

本机若已有绑定到其他服务器（例如 staging）的 Computer，不要用页面 `curl|sh` 升级它；生产二进制会拒绝现有绑定。`host` 二进制与日常 `~/.local/bin/coforge-computer` 分开存放。

## 核对

- `systemctl is-active coforge-host.service` 为 `active`
- 「云电脑服务」页心跳绿灯（90s）
- 创建工作区后 `docker service ls` 出现 `coforge-<电脑编号>`，镜像 `coforge-computer:production`，副本 `1/1`
- 容器日志有 `Daemon cloud connection established`
- 电脑页 Cloud 在线；桌面可走 `http://10.110.158.147:6090` 或 `https://coforge.cn/desktop/...`（经 Caddy）
