# 5. 一次性准备：RAM 角色与 GitHub Environment

以下步骤只有 Frank 或其明确授权的阿里云 / GitHub 管理员能做，Agent 不能代为创建：

1. 在 RAM 创建角色 `coforge-cdn-cert-renewal`，用[第 4 节](ram-permissions.md)的信任策略，
   并附加同节的自定义权限策略；不要选择系统预置的 FullAccess 策略。
2. 在 GitHub 仓库创建 Environment `certificates`：只允许 `main` 分支，不设审批人，不存任何 secret。
3. 先手动触发 `Renew CDN certificates` 并勾选 `staging`（测试 CA 干跑，不上传），确认全部域名签发成功；
   再触发一次并勾选 `force`，确认每个域名的日志都以
   `edge now serves a certificate valid until ...` 结尾，且[第 7 节](verification.md)的 issuer 是
   Let's Encrypt。
4. 在变更记录里保存：运行链接、各域名的新到期时间。不要保存任何凭据；工作流不产生也不持有
   长期凭据，也不在日志里打印私钥或 STS 值。
