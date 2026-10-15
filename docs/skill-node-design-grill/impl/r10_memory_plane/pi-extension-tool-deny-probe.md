# Pi extension 可行性探针（R10-S1，只读；未改 extension / harness）

**结论（给用户裁定 oracle 泄漏修法 ⒝）**：Pi **没有** `unregisterTool`；但 extension 在加载期可用 **`pi.setActiveTools(toolNames)`** 把活跃工具面收窄到不含 `bash`/`read`/`write`/`edit`，或用 **`pi.registerTool({ name: "bash", ... })` 等同名覆盖**内置实现。二者在 `pi-coding-agent@0.0851` 的合并规则下**理论上可生效**；本仓库 harness **从未用过** `setActiveTools`，需在 `skillsbench_extension_gen.py` 改生成物后**实测**一轮才能确认 bench-runner 会话不会把 builtins 重新全开。

## 证据

| 项 | 位置 | 要点 |
|---|---|---|
| `registerTool` | `pi-coding-agent/dist/core/extensions/loader.js` L238–245 | `extension.tools.set(tool.name, …)` + `runtime.refreshTools()` |
| 无 unregister | 全包 `rg unregisterTool` → 无工具注销 API；仅有 `unregisterProvider`（模型 provider） |
| 同名覆盖 | `agent-session.js` L2155–2158 | builtin 先入 `toolRegistry`，extension 工具 **后 set，同名覆盖** |
| `setActiveTools` | `loader.js` L331–334 → `agent-session.js` L659–672 | ExtensionAPI：`pi.setActiveTools(toolNames)`；未知名忽略；**下一 agent turn 生效** |
| 默认活跃 builtins | `agent-session.js` L2208–2210 | 无 override 时默认 `["read","bash","edit","write"]` |
| 当前 extension 生成 | `evol_bench/SkillsBench/code/skillsbench_extension_gen.py` | 仅 `registerTool(run_command)` + room bridge；**未**调用 `setActiveTools` |
| Harness 侧 | `pi-group-chat-host/internal/pi/profile.go` L30–40 | `NewOrdinaryAgentProfile`：`BuiltinToolsEnabled: true`, `AllowedToolNames: nil` ⇒ 全量 builtin 注册进 Pi；限制只能走 extension 或改 profile（⒜） |

## 建议调用形态（未实施）

```javascript
export default function (pi) {
  // …现有 run_command + room_bridge…
  const keep = pi.getAllTools().map(t => t.name).filter(n =>
    !["bash", "read", "write", "edit"].includes(n));
  pi.setActiveTools(keep);
}
```

或对每个禁用的名字 `registerTool({ name: "read", execute: () => ({ content: [{ type: "text", text: "ERROR: disabled" }] }), … })`。

**未实测项**：bench-runner 是否在每 turn `reload` 扩展、以及 `includeAllExtensionTools` 是否会再次把 `bash` 加回 active 列表 — 需改生成器后跑 1 episode 验证，本次 S1 不阻塞。
