# 在 staging 上启用云电脑

一套 staging 只绑定一个 Swarm。下面按实际启用顺序写：令牌、发布 Computer、准备电脑镜像、在管理节点启动 `host`、再核对工作区里的电脑。通用约定在 [对接 Swarm](README.md)。

设置里的「云电脑服务」在核对操作密码之后，可以下载一份在管理节点执行的安装脚本。脚本写入令牌和已绑定的节点密钥，页面上不显示这两项。网页不能在 Swarm 节点上启动进程。操作密码是 Web 进程的 `COFORGE_CLOUD_SERVICE_PASSWORD`，6 到 200 个字符。没设这个变量时，这一页停留在密码输入。

## 令牌

用 `openssl rand -hex 32` 生成一次。同一份明文放两处：

- GitHub Environment `staging` 的 secret `COFORGE_CLOUD_CLUSTER_TOKEN`。部署写到 staging 主机的 `secrets/coforge_cloud_cluster_token`，再传进 Web 容器。
- 管理节点上 `host` 的 `COFORGE_CLUSTER_TOKEN`。

服务端只保存哈希。两处不一致时，注册被拒绝（`invalid host token`）。不要再生成第二把，也不要把明文写进仓库、镜像层、日志或页面上的复制框。

## 发布 Computer

云应用随 `main` 自动部署。带 `host` 的 Computer 要另外手动发布，并且必须从 `main` 触发，否则发布任务会被跳过：

```sh
gh workflow run release-staging.yml --repo lrm-lab/coforge --ref main
```

不填版本号时，发布当前开发线的下一个 `0.1.2-dev.N`，并把 `https://releases-staging.coforge.cn/latest` 指到它。这个二进制在编译时写死 `https://staging.coforge.cn`。合并进 `main` 之前发布的版本没有云电脑的 `host`。

## 电脑镜像

镜像在单独的仓库 `git@github.com:exp-repair/create_docker_image_for_pi.git` 里构建。

```sh
./scripts/build-swarm.sh
```

脚本从 staging 发布源下载 `linux-x64` 的 `coforge-computer`，校验和通过后打标签 `coforge-computer:staging`。镜像入口是 `coforge-computer foreground`。`host` 创建服务时不覆盖命令，也不在启动时执行 `setup --workspace`。`PATH` 上有 `systemctl`（容器内的 shim）、`curl` 和 `gzip`。Pi 和联想 CA 打进镜像。构建机上如果有 `config/pi-agent/models.json`，它覆盖烘焙出的 DeepSeek 配置，用的是这台机器 `~/.pi/agent` 里已经能对话的那一份。这些文件含密钥，不进 git，也不要把镜像推到公开仓库。

`host` 使用 `--no-resolve-image`。节点上没有 `coforge-computer:staging` 时不会去仓库拉。这次的 Swarm 只有管理节点 `ubuntu`，镜像就构建在这台机器上。

## 启动 host

在管理节点执行「云电脑服务」页下载的 `coforge-host-bootstrap.sh`。脚本里的服务器地址是打开页面用的地址。它把二进制放在 `~/.coforge-host/coforge-computer`，不替换 `~/.local/bin/coforge-computer`，写入下面的 `host.env`，停掉用户服务，再安装系统服务。执行它需要 sudo。

管理节点上如果已经有一份绑定到其他服务器的 Computer，不要用 `curl | sh` 安装器升级它。staging 二进制会拒绝现有绑定（`Binding server does not match this daemon build`），安装器等 60 秒后回滚。

令牌和节点密钥在该目录下、权限 `600` 的 `host.env`：

```
COFORGE_CLUSTER_TOKEN=<与 staging secret 相同的明文>
COFORGE_CLUSTER_NODE_KEY=<openssl rand -hex 32，只生成一次>
COFORGE_CLUSTER_NAME=staging
COFORGE_COMPUTER_IMAGE=coforge-computer:staging
```

系统服务 `/etc/systemd/system/coforge-host.service`，以拥有 `host.env` 的用户运行，并加入 `docker` 组。不要用用户服务：用户服务挂在登录会话上，注销后心跳和领任务都会停。

```
[Unit]
Description=CoForge Swarm host
After=docker.service
Wants=docker.service

[Service]
User=<拥有 host.env 的用户>
Group=<该用户的主组>
SupplementaryGroups=docker
EnvironmentFile=/home/<用户>/.coforge-host/host.env
ExecStart=/home/<用户>/.coforge-host/coforge-computer host --server-url https://staging.coforge.cn
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```sh
sudo cp coforge-host.service /etc/systemd/system/coforge-host.service
sudo systemctl daemon-reload
systemctl --user disable --now coforge-host.service
sudo systemctl enable --now coforge-host.service
```

先停掉用户服务，再启动系统服务，避免两个 `host` 用同一把节点密钥。第一次注册成功后，节点密钥绑死。终端里另外生成、但没有用来注册的密钥不能再拿来启动第二个 `host`。

## 工作区里的电脑

一个账号只有一台不能删除的默认云电脑，名字是 Cloud。新用户完成注册，或再创建一个工作区之后，会把这同一台挂进该工作区，所以每个工作区都能看到它。每个工作区一个 Daemon，都在同一个容器里，可以同时在线。在线灯是这个工作区的 Daemon 在 90 秒内向 staging 报过在线。容器当时还没就绪时，打开该工作区的电脑页会再挂一次。

再挂一个工作区时，`host` 在正在运行的容器里执行 `__attach-workspace`，只启动这个工作区的 Daemon。已经连上的其他工作区保持运行。刷新电脑页后，已经挂上的工作区都会显示在线。

「此电脑未关联 Agent」表示这个工作区还没有把 Agent 指派到这台电脑。镜像里已经有 Pi，不会因此自动出现 Agent。

## 核对

- `systemctl is-active coforge-host.service` 为 `active`，没有令牌或节点密钥错误。注销后这个状态不变。
- 「云电脑服务」页的灯在心跳到达后变绿。心跳超过 90 秒未到则变回未连接。
- 创建一个工作区后，`docker service ls` 出现 `coforge-<电脑编号>`，镜像是 `coforge-computer:staging`，副本为 `1/1`。
- 容器里每个已挂载工作区有一个 `__workspace-daemon`，日志里有 `Daemon cloud connection established`。
- 电脑页上 Cloud 在线。要使用它，还要在该工作区把 Agent 指派到这台电脑。
