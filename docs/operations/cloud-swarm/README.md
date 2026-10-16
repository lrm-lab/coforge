# 新环境对接 Swarm

一套新的 CoForge 部署只绑定一个 Docker Swarm 集群。服务端决定这个账号有没有云端电脑、任务发不发得出去；Swarm 管理节点上的 `coforge-computer host` 领取任务并创建或删除服务。工作区 Daemon 在云电脑容器里启动，不要在 Swarm 节点上再装一份。

云电脑属于用户账号：一台不能删除的默认电脑。每个工作区还可以再加一台额外云电脑。新用户完成注册，或再创建一个工作区之后，就确保这台默认电脑并挂上该工作区。已有电脑进入另一个工作区时，是往同一个容器挂载该工作区，不新开一台电脑。电脑页再次打开时做同样的确保，所以容器当时还没就绪的挂载会在那里补上。

## 服务端

先把包含 `host_nodes`、`host_jobs` 和 `computers.cloud_slot` 的数据库迁移应用到这套环境。

生成集群令牌：16 到 200 个字符，中间不能有空白。`openssl rand -hex 32` 的结果符合这个范围。把同一份明文只放进 Web 进程的 `COFORGE_CLOUD_CLUSTER_TOKEN`。服务端只保存它的哈希。这个变量缺失、短于 16 个字符，或含有空白时，这套环境不提供云端电脑。

Staging 不把令牌写进仓库。把它存成 GitHub Environment `staging` 的 secret `COFORGE_CLOUD_CLUSTER_TOKEN`。部署时 workflow 写到主机 `secrets/coforge_cloud_cluster_token`，再传进 Web 容器。没设这个 secret 时，staging 部署会停住。

令牌、节点密钥和 Daemon 密钥不要写入仓库、镜像层、日志或命令回显。

镜像标签由管理节点上的 `host` 决定。服务端不用 `COFORGE_COMPUTER_IMAGE` 选镜像。

## 容器要能访问的地址

容器里的 `127.0.0.1` 是容器自己。`host` 和容器都要能访问这套环境的 Web；容器还要能访问 Centrifugo 的 `/connection/websocket`。

放进镜像的 `coforge-computer` 在编译时写死 Daemon 的 HTTP 源。`host` 传给容器的 `COFORGE_SERVER_URL` 必须和这个源的 origin 相同，否则容器拒绝写入绑定（`Binding server does not match this daemon build`）。

按现有发布脚本编译时，`scripts/release/compile-targets.ts` 会把该环境的服务器 URL 写进 `COFORGE_DAEMON_SERVER_URL`。Websocket 由这个 URL 推导为 `wss://<主机>/connection/websocket`（HTTP 部署则是 `ws://`）。标准部署里 Caddy 把 `/connection/*` 转到 Centrifugo，容器使用这个公网源即可。

Web 和 Centrifugo 不在同一个对外地址上时，按 `scripts/e2e/build-computer-fixture.ts` 编译：`COFORGE_E2E_WEB_URL` 是容器能访问的 Web 源，`COFORGE_E2E_CENTRIFUGO_ENDPOINT` 是容器能访问的 Websocket。`host` 的 `COFORGE_SERVER_URL` 用同一个 Web 源。

## 电脑镜像

镜像是 Linux 镜像，里面是为这套环境编译的 `coforge-computer`。入口执行 `coforge-computer foreground`。这个监督进程通过 systemd 用户实例启动每个工作区的 Daemon，因此镜像的 `PATH` 上要有可用的 `systemctl`。基础镜像没有 systemd 时，要自备一个能拉起这些 unit 的 `systemctl`，否则任务退出后 Swarm 会按重启策略反复拉起。

把镜像加载到将会运行任务的每个节点上，标签与下面的 `COFORGE_COMPUTER_IMAGE` 一致。`host` 创建服务时使用 `--no-resolve-image`，节点上没有这个标签时不会去仓库拉取。

## 准备 Swarm

在管理节点初始化，广播地址用 Swarm 节点之间互相访问的地址。它不是 CoForge 的服务器地址。

```bash
docker swarm init --advertise-addr <节点之间可达的地址>
```

`docker node ls` 里要有状态为 `Ready` 的节点。`host` 调用本机的 `docker`，所以它要跑在能管理这个 Swarm 的机器上，通常就是这个管理节点。

给集群加机器时，在新机器上 `docker swarm join`，并把同一份镜像放到新节点上。`host` 仍然只跑一份。

## 启动 host

在管理节点使用带 `host` 子命令的 `coforge-computer`。五个值缺一不可，可以用环境变量，也可以用同名参数。设置里的「云电脑服务」在核对操作密码之后，可以下载一份在管理节点执行的安装脚本。脚本写入令牌和已绑定的节点密钥，页面上不显示这两项。操作密码是 Web 进程的 `COFORGE_CLOUD_SERVICE_PASSWORD`，6 到 200 个字符。没设这个变量时，这一页打不开。

这台机器上如果已经有一份绑定到其他服务器的 Computer，不要用页面上的 `curl | sh` 升级它。安装器会换成这套环境的二进制，现有绑定对不上时监督进程退出（`Binding server does not match this daemon build`），然后回滚，`host` 不会启动。把 `host` 用的二进制放到单独目录。Staging 的具体步骤见 [在 staging 上启用云电脑](staging-bring-up.md)。

| 变量 | 作用 |
| --- | --- |
| `COFORGE_SERVER_URL` | 容器能访问的 Web 源，origin 与镜像里写死的 Daemon 服务器一致 |
| `COFORGE_CLUSTER_TOKEN` | 与服务端 `COFORGE_CLOUD_CLUSTER_TOKEN` 相同 |
| `COFORGE_CLUSTER_NODE_KEY` | 这个管理节点的稳定密钥，1 到 200 个字符，无空白 |
| `COFORGE_CLUSTER_NAME` | 上报的集群名称，1 到 200 个字符 |
| `COFORGE_COMPUTER_IMAGE` | 节点上已经存在的镜像标签 |

```bash
coforge-computer host
```

进程在前台运行，默认每 5 秒向服务端注册心跳并领取任务。领取或回报失败时进程退出。用这台机器的服务管理把它保持运行；仓库不附带这份单元文件。

第一次注册成功后，服务端把 `COFORGE_CLUSTER_NODE_KEY` 绑到这一条集群记录上。以后每次启动都用同一把密钥。换管理节点时先停掉旧的 `host`，在新管理节点上使用原来的密钥和令牌。密钥不同会被拒绝（`node key is already bound`）。令牌不同会被拒绝（`invalid host token`）。密钥要和令牌一起保管。

`docker node ls` 里没有 `Ready` 节点时，心跳里的 `accepting` 为假：创建任务留在队列里，删除和挂载仍会领取。出现 `Ready` 节点后，同一条创建任务会被领走。

## 电脑如何落上集群

新用户完成注册，或再创建一个工作区之后，服务端确保该账号的默认云电脑。还没有这台电脑时，放入一条 `create` 任务。`host` 领到后创建单副本服务，名称是 `coforge-<电脑编号>`，标签 `coforge.computer_id=<电脑编号>`，数据卷挂到容器内 `/root/.coforge`。服务起来后，容器里的 `foreground` 为这个工作区启动 Daemon。

该用户再创建一个工作区，并且这台电脑的容器已经就绪时，服务端放入一条 `attach` 任务。`host` 在正在运行的任务里执行 `coforge-computer __attach-workspace`。它把这个工作区写进数据卷，并让已经在跑的 `foreground` 只启动这个工作区的 Daemon。已经连上的其他工作区保持运行。一个 Daemon 只连接一个工作区，多个工作区的 Daemon 可以同时在线。容器还没就绪时这次不放入挂载任务；之后打开该工作区的电脑页会再确保一次。

Agent 的工作目录在数据卷 `/root/.coforge/agent-workspaces` 上。换掉容器之后，Pi 仍能打开原来的会话。

电脑页上的「此电脑未关联 Agent」表示这个工作区还没有把 Agent 指派到这台电脑。镜像里有 Pi 不会自动创建 Agent。

领取顺序是删除、挂载、创建。Daemon 密钥只在领取 `create` 或 `attach` 时出现，回报后从任务行清掉。

## 核对

- `host` 进程保持运行，没有注册或令牌错误。
- 创建一个工作区之后，`docker service ls` 出现 `coforge-<电脑编号>`，副本为 `1/1`。
- 该服务的日志里，Daemon 已连上这套环境。
- 电脑页上这台云电脑显示在线。

默认云电脑没有删除入口。某个工作区的额外云电脑要等 `host` 回报服务已经消失，这个工作区的名额才会空出来。

格式化不是删除。它要求用户输入这台电脑现在显示的名字，服务端再核对一次。核对通过后，`host` 删掉服务和数据卷，再按同一个电脑编号创建空盘并挂回原来的工作区。Agent、消息和工作区链接留在服务端。默认云电脑是各工作区共用的，格式化会清掉挂在上面的每个工作区的本机文件。
