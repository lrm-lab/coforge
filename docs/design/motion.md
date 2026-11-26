# 16. 动效与微交互

动效只服务于操作反馈与状态连续性，不做装饰性循环闪烁或首次渲染的炫技入场。所有时长、缓动与减动规则集中定义在 `apps/web/src/styles.css` 与 `apps/web/src/utils/motion-tokens.ts`，由 `apps/web/src/styles/motion-policy.test.ts` 保证 CSS 与 TS 令牌单源同步。

## 1. 时长与缓动令牌

退场永远快于或等于入场（`out <= in`）：

| 档位 | 入场 | 退场 | 用途 | 工具类 |
| --- | --- | --- | --- | --- |
| `sm` | `200ms` | `150ms` | 按钮加载切换、轻弹层、Toast、批量操作条 | `motion-enter-sm` / `motion-enter-strong` / `motion-leave-sm` |
| `md` | `300ms` | `200ms` | 弹窗、折叠展开（`Fold`）、空状态入场、通知卡片 | `motion-enter` / `motion-leave` |
| `lg` | `400ms` | `280ms` | 子页面切换（`subpage-transition.css`）、侧栏宽窄切换 | `motion-enter-lg` / `motion-leave-lg` |
| `label` | `140ms` | `60ms` | Tooltip 文本标签（纯淡入淡出） | `motion-label-enter` / `motion-label-leave` |
| `card` | `200ms` | `120ms` | `HoverPopover` / `HoverCardGroup`（淡入 + 4px 位移，组内 200ms 交叉淡入） | `motion-card-enter` / `motion-card-leave` |
| `preview` | `250ms` | `140ms` | 大型悬停预览面板（淡入 + 8px 位移） | `motion-preview-enter` / `motion-preview-leave` |

缓动曲线：`--ease-out`（默认出减速）、`--ease-out-strong`（`cubic-bezier(0.22, 1, 0.36, 1)`，用于强调到位）、`--ease-in`（退场加速）、`--ease-in-out`、`--ease-overshoot`、`--ease-spring`（支持 CSS `linear()` 时为物理弹簧，否则回退 `--ease-out-strong`）。入场动画优先使用 `backwards` 而非 `both`，避免静止态残留合成层。

## 2. 减动效与触摸不变量

- `prefers-reduced-motion: reduce`：全局禁用 `.animate-in`/`.animate-out` 与 `[data-entering]`/`[data-exiting]` 的位移、缩放与旋转，统一降级为纯淡入淡出或即时切换；每个含时间动效的自定义 CSS 文件必须提供减动效分支（`motion-policy.test.ts` 校验）。
- 触摸无悬停：自定义样式表里的 `:hover` 必须包裹在 `@media (hover: hover)` 内（`motion-policy.test.ts` 校验）；触摸按下反馈走 `@media (hover: none)` 的透明态；粗指针命中区域不小于 `44px`（`min-h-11 min-w-11`）。
- 仅使用合成层属性（`transform`、`opacity`）和 CSS Grid `grid-template-rows` 折叠，不做 `height`/`max-height` 过渡。

## 3. 核心交互与微交互契约

| 机制 | 实现位置 | 核心参数与边界 |
| --- | --- | --- |
| 按压微缩放 | `styles.css` `[data-press-scale]` | `scale: 0.97` 弹簧按压；禁用、加载中、拖拽中及菜单触发器自动豁免；减动效关闭 |
| 按钮加载惯性 | `components/ui/loading.ts` + `styles/button-loading.css` | 延迟 `150ms` 显示、显示后最少停留 `400ms`、锁定按钮宽度防止抖动；内容或意图变化时立刻结束过渡 |
| 路由骨架惯性 | `lib/pending-policy.ts` | 路由默认 `PENDING_DELAY_MS = 300ms` / `PENDING_MIN_MS = 300ms`（仅 `_chat.tsx` 例外 `0ms`，由 `pending-policy.test.ts` 锁定） |
| 悬停分层时序 | `lib/hover-intent.ts` + `tooltip.meta.ts` + `hover-popover.meta.ts` + `dropdown-submenu.meta.ts` | Label `500ms` / 冷却 `400ms`；Card `700ms` / 离开宽限 `300ms` / 满宽桥接 / `0.1px/ms` 90ms 测速后 `60ms` 慢切；点击打开的根菜单移出不自动关闭，含输入框/选择项的子菜单强制 `openOnHover={false}` |
| 子页面转场 | `styles/subpage-transition.css` | View Transition `subpage-push`（`400ms`）与 `subpage-pop`（`280ms`），底层 `translate3d(-10%) scale(0.95)`，减动效纯淡入淡出 |
| 滑动指示条 | `hooks/use-sliding-indicator.ts` | 弹簧 `stiffness: 400, damping: 30` 拉伸过渡（underline / pill），减动效即时定位 |
| 拖拽排序涟漪 | `components/ui/drag-ripple/` | 抬起 `(0.18s, bounce 0.4)`、落位 `(0.3s, bounce 0.1)`，纯 `translate3d` 位移；减动效仅保留插入线 |
| 高度折叠 | `components/ui/fold.tsx` | `grid-rows-[0fr/1fr]` + `opacity` + `inert={!open}`，避免焦点落入折叠区域 |
| 数字滚动 | `components/ui/rolling-number.tsx` | 弹簧 `(0.3s, bounce 0.15)` 逐位进位；首帧不滚，减动效直接切换；不做飞向徽标动效 |
| 移动端悬浮底栏 | `styles/floating-foot-bar.css` | `interpolate-size: allow-keywords` `280ms` 折叠/展开；磨砂底板画在 `::before` 以兼容 Safari 26+ 工具栏采样 |
| 弹窗角色分层 | `components/ui/modal.tsx` | `page`（手机 `< sm` 进入文档流适配 iOS 键盘）、`confirmation`（手机底部滑出抽屉）、`instant`（搜索/快捷键零动效直出） |
| LazyMotion 严格模式 | `routes/__root.tsx` + `components/ui/motion-features.ts` | 仅使用 `import * as motion from "motion/react-m"`，禁止从 `motion/react` 同步导入 `motion` |

## 4. 机器可读元数据与自动门禁

- **组件契约（`*.meta.ts`）**：`apps/web/src/components/ui/` 与 `base/` 下核心交互与动效原语通过 `ComponentMeta`（`component-meta.ts`）声明 `whenToUse`、`whenNotToUse`、`timing`、`motion`、`accessibility`、`limits`，由 `component-meta.test.ts` 校验完整性与退出时长不大于入场时长。
- **Oxlint 强制规则**（`apps/web/scripts/oxlint-plugin.js`）：
  - 悬停：`coforge/no-custom-hover-delay`、`coforge/no-raw-hover-primitives`、`coforge/no-hover-input-submenu`
  - 动效与原语：`coforge/no-sync-motion-import`、`coforge/no-distracting-animations`、`coforge/no-browser-dialogs`、`coforge/no-raw-toast-library`、`coforge/no-raw-file-type-icon`、`coforge/no-native-button`、`coforge/no-native-select`、`coforge/no-native-title`、`coforge/one-avatar`
- **样式与策略测试**：`motion-policy.test.ts`、`coforge-theme.test.ts`、`typography-scale.test.ts`、`pending-policy.test.ts`、`component-meta.test.ts`、`ui-lint.test.js`。
