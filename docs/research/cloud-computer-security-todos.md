# 云电脑安全整改 Todo

对照一次代码审查的发现（桌面代理、Swarm 容器、daemon/runtime 授权）。目标用户视角：张三注册账户后使用云电脑时，哪些门没锁严。

未勾选 = 未做。勾选后在同一行或紧接下方注明 CR / 提交。

## P0 — 桌面入口（张三屏幕可能被内网直连）

- [x] **统一桌面入口走鉴权路径**
  `COFORGE_CLOUD_DESKTOP_ORIGIN` 改为站点源（production `https://coforge.cn`，staging `https://staging.coforge.cn`），「打开桌面」与 page-fill 走 Caddy `forward_auth`。
  相关：Compose；`cloud-desktop-url.ts`；`infra/*/caddy/Caddyfile`。分支 `fix/cloud-desktop-owner-auth`。

- [x] **6090 不得对不可信网络暴露**
  Caddy 在 `forward_auth` 通过后带上与集群令牌相同的 `X-Coforge-Desktop-Proxy-Secret`；host 无该头则拒绝 `/desktop`（含 fill/inspect）。监听仍可为 `0.0.0.0:6090`，密钥门禁替代「仅靠防火墙」。
  相关：`desktop-proxy.ts`；`run-host.ts`；Compose `COFORGE_DESKTOP_PROXY_SECRET`；运维 `cloud-swarm` 文档。

- [x] **直连代理上的 `/fill`、`/inspect` 与桌面同级鉴权**
  同一 proxy secret 门禁覆盖全部 `/desktop/...` 路由；修正 `page-fill.server.ts` 注释。

## P1 — 容器与密钥残留（运维/同机房侧）

- [ ] **Swarm service spec 不再长期保留 `COFORGE_DAEMON_API_KEY`**
  进程内清 env 不够；create/attach 后从 service `--env` 剥离，或改为一过性注入。
  相关：`docker-containers.ts`；`run-host.ts`；`host-process` 测试预期。

- [ ] **云电脑容器硬化**
  非 root、`cap-drop`、`no-new-privileges` 等；评估对现有镜像与 Agent 工作区的影响（可能需 Frank 对边界类变更点头）。
  相关：`dockerServiceCreateArgs`；`packages/computer/docker/Dockerfile`。

- [ ] **`VNC_WS_TOKEN` 暴露面收敛**
  与 daemon key 一样，避免长期躺在 `docker service inspect` 可读的 env 里。
  相关：`run-host.ts`；`desktopEndpoint` inspect 路径。

## P2 — 共享信任域与密钥面

- [ ] **明确或收紧「整机一份」runtime 登录模型**
  多 Workspace 挂同一台云机时，Claude/Codex 等登录按 Computer×provider 共享。要么产品文档写清「同机即共享信任域」，要么做 per-Workspace 隔离方案（后者是产品/架构决策）。
  相关：`runtime-auth-store.server.ts`；`computers/AGENTS.md`。

- [ ] **淘汰 Centrifugo connect body 里的 `daemonApiKey`**
  只走 header；收紧旧 Daemon 与日志策略，避免密钥进正文日志。
  相关：`connect-proxy.server.ts`。

- [ ] **`desktop-authorize` 增加「仅反代可调」门卫**
  对齐 Centrifugo 内部路由的共享密钥模式，降低误配与 Cookie 侧信道面。
  相关：`routes/api/internal/desktop-authorize.ts`。

## P3 — 一致性与边角

- [ ] **隐藏的默认云机：restart / catalog 与列表规则对齐**
  `canManage` 已挡 runtime IDOR；重启与 catalog 若仍仅靠「成员 + 链接」，补上 `defaultCloudComputerHiddenFromViewer` 或同等规则。
  相关：`computer-membership.server.ts`；`computers.functions.ts`。

- [ ] **评估 `window.opener` 保留策略**
  同名窗口复用 vs 同源 tabnabbing；若桌面统一走站点源，再定是否可 `noopener` 或换复用方式。
  相关：`cloud-desktop-url.ts`；`docs/computer/container-host.md`。

## 已确认不必当作漏洞改的（记录以免重复开单）

- 默认云机对非 owner 的 runtime 管理（sign-in / usage / reset credit）已有隐藏 + `canManage` 测试覆盖。
- Agent 启动剥离 `COFORGE_DAEMON_API_KEY`；凭证文件 0600；claim report 后 DB 侧清 job key。
- Caddy 路径下的桌面：会话 + 云机 owner + UUID 校验 + VNC token 不进浏览器 URL（问题在「产品默认不走这条路」）。

## 验收时怎么想（张三视角）

| 场景 | 期望 |
|------|------|
| 只走官网打开桌面 | 必须已登录且是机主；未登录进不去 |
| 内网有人只知道电脑 UUID | 打不开他的桌面，也不能 `/fill` |
| 同事在同一 Workspace | 仍看不到他的默认云电脑敏感操作（保持现状） |
| 运维 docker inspect | 看不到长期挂着的 daemon / VNC 密钥 |
