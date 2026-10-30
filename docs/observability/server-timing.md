# Server-Timing

Web/backend 在 `COFORGE_SERVER_TIMING=1` 时，为已登录会话的 SSR 文档（`text/html` 响应）和
Server Function 响应追加 [W3C Server Timing](https://www.w3.org/TR/server-timing/) 头：

```
Server-Timing: total;dur=16.6, db;dur=9.5
```

浏览器 DevTools 的 Network → Timing 面板和 `PerformanceResourceTiming.serverTiming`
（导航条目与 `/_serverFn/` 资源条目）直接读取它
（[MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Server-Timing)）。

| 指标 | 含义 |
| --- | --- |
| `total` | CSRF 检查之后、其余中间件与处理器开始到响应头就绪的毫秒数。SSR 为流式响应，它覆盖 loader、dehydrate 与首段渲染，不含其后的流传输。 |
| `db` | `total` 内至少有一条 Prisma 查询在执行的毫秒数（并发查询只算一次，含连接池等待），因此不超过 `total`。 |

`/api` 下的非 HTML Server Route 不带此头；`/api/agent/*` 的耗时见结构化日志 `agent_http.request_finished`。

## 实现

`src/start.ts` 中紧跟 CSRF 检查的请求中间件调用 `withServerTiming`
（`src/server/observability/server-timing.server.ts`）。它用 `AsyncLocalStorage` 把 Prisma
`query` 事件归到发起它的请求；请求之外的查询（后台 sweep）被丢弃。开关关闭时 Prisma 不开启 query
事件，因为开启后每条查询都要格式化参数。

归属依赖一个 Prisma 官方文档没有写明的行为：`query` 事件在发起查询的调用方的异步上下文里触发。这一点在
Prisma 7.10 上验证过，由 `apps/web/test/server-timing-prisma.integration.ts` 用真实查询守住；升级
Prisma 后这个测试失败，说明 `db` 已不可信。

## 安全边界

头里只有两个固定指标名和数字 `dur`，没有 `desc`，不含路径、ID、查询文本或用户数据；服务端不发送
`Timing-Allow-Origin`，所以跨源页面读不到它。DB 耗时拆分比总响应时间更精确，如果发给未登录的请求，
登录、找回密码这类接口上的时间差可能被用来探测账号是否存在。W3C 规范的隐私与安全一节允许服务端只向
已认证用户提供这些指标。

因此只对“要求登录、并且通过了登录校验”的请求追加：`requireBrowserSignIn`（Server Function 的
`authMiddleware` 走它；页面在 SSR 时经由 loader 调用的这类 Server Function 也算）校验通过时调用 `recordSignedInRequest` 标记当前请求。对未登录的人开放的
接口（登录、找回密码、以后新增的公开接口）不经过这一步，所以无论调用者是否带着有效会话都不带这个头；
只读取“可选登录”（`optionalBrowserSignIn`）也不算。规则落在认证这一层，不是接口名单。
`apps/web/test/server-timing-sign-in.test.ts` 覆盖：已登录调用普通接口带；已登录调用不经过登录校验的接口（登录、找回密码这类）不带；
没有会话、会话伪造或过期、未配置会话密钥都不带。

开启后 Prisma 对所有查询都发 query 事件（包括不带头的请求和后台任务），只有响应头按上面的规则过滤；
本地生产构建实测开与关的延迟和 CPU 差别在测量波动之内。

staging 和生产都在各自的 `infra/*/docker-compose.yml` 中开启。生产开启、且只对已登录会话发送，
由协调员 coforge-raft 在 Frank 授权下于 2026-10-31 决定（task #348）。
