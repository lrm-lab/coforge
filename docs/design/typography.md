# 14. 字体与字号

来源：设计稿「Coforge UI 设计规范 · Typography」（持续更新）。设计稿与本文冲突时以设计稿为准，并同步改本文。

## 字体

| 用途 | 字体 | 回退 |
| --- | --- | --- |
| 英文 / 数字 | Inter | 系统无衬线 |
| 中文 | Noto Sans SC（思源黑体简体中文） | Windows 回退微软雅黑；Linux 回退 Noto Sans CJK SC |
| 代码 | JetBrains Mono | 系统等宽 |

- 字体栈：`Inter Variable` → `Noto Sans SC Variable` → 微软雅黑 → Noto Sans CJK SC。Inter 和 Noto Sans SC 都由 `@fontsource-variable` 自托管；Noto Sans SC 按 unicode-range 切成约 100 个 woff2，浏览器只下载页面用到的字，不要对它做 preload。
- 定义在 `apps/web/src/styles.css`（`--font-body`、`--font-display`、`--font-mono`），不要在组件里写 `font-family`；代码和标识符用 `font-mono`，另外 Activity 行的相对时间按 Raft 设计稿也用 `font-mono`。`theme.css` 里的同名变量被它覆盖，不手改。
- 落地页同样用这套栈（`font-display`）；仓库里没有 Geist，也没有单独的展示字体。
- 字体许可是 OFL-1.1，随 npm 包分发；不要把字体文件拷进仓库。

## 字号与行高

字号和行高成对使用，不单独改行高。数字是根字号 16px 下的换算，实现时写 Tailwind 类（见[第 12 节](sizing-units.md)）。

| 字号 / 行高 | rem | Tailwind 类 | 使用场景 |
| --- | --- | --- | --- |
| 12px / 18px | 0.75 / 1.125 | `text-xs` | 代码、时间信息 |
| 14px / 20px | 0.875 / 1.25 | `text-sm` | 小标题、对话内容预览、用户名、侧栏导航 |
| 16px / 24px | 1 / 1.5 | `text-md` | 标题、正文 |
| 18px / 28px | 1.125 / 1.75 | `text-lg` | 特殊标题 |
| 20px / 30px | 1.25 / 1.875 | `text-xl` | 大标题 |
| 24px / 32px | 1.5 / 2 | `text-display-xs` | 特殊场景 |
| 30px / 38px | 1.875 / 2.375 | `text-display-sm` | 特殊场景 |
| 36px / 44px | 2.25 / 2.75 | `text-display-md` | 特殊场景 |

## 规则

- 只用上表八档。没有 11px、13px、17px 这类中间档；不写 `text-[0.8125rem]`，需要时选相邻的一档。
- 24px 及以上用 `text-display-*`，不用 Tailwind 默认的 `text-2xl/3xl/4xl`：默认的 `text-3xl` 行高是 36px、`text-4xl` 是 40px，和规范的 38px、44px 不一致（`text-2xl` 恰好等于 24/32，但同样改用 `text-display-xs`）。
- 不用 `leading-*` 改某一档的行高；单行且不换行的元素（徽章、图标按钮）可以用 `leading-none`。
- 官方 Untitled UI 组件（`components/base|application|foundations`）和 CLI 生成的 `theme.css` / `typography.css` 保持上游原样，不在审查范围内。
- 公开首页 `features/landing` 按冻结视觉保留。

## 保留的例外（2026-10-09 审查后）

产品代码里已没有档外字号，也没有覆盖档位行高的 `leading-*`（单行元素的 `leading-none` 除外）。下面这些是有意保留的：

- **消息字号**：Settings → Message font size 提供 12 / 14 / 16px 三档，默认 14px（不是正文的 16px）。消息文本里的 `text-xs/sm/md/lg/xl` 按所选档在规范上整体平移（默认：12 / 12 / 14 / 16 / 18px，各自取规范的行高；`xs` 和 `sm` 最小停在 12/18），不是乘一个系数，所以消息区里也没有档外字号。这是产品决策，不是偏差。
- **消息时间戳**：`message-row.tsx` 里悬停显示的时间用 `text-[length:0.75rem]` 加 `leading-[var(--text-md--line-height)]`，固定 12px，行高跟消息行一致，不随消息字号缩放。
- **官方组件**：`components/base` 里 `avatar-count.tsx` 的 `text-[10px]` 保持上游原样；产品里没有任何地方给 `Avatar` 传 `count`，它不会出现在界面上。
- **落地页**：`features/landing` 按冻结视觉保留，其中终端文字用 `text-xs`。
- **沙箱 iframe**：报告编辑器里的 Mermaid 图在 `sandbox` iframe 里，加载不了应用的网页字体，只在 `srcDoc` 里列出本机同名字体（Inter、Noto Sans SC、微软雅黑、Noto Sans CJK SC）的精简栈，本机装有这些字体时才生效；HTML 预览 iframe 是用户自己的 HTML，不注入字体。
- **导出的周报 HTML**：独立文档，字体栈和字号档位按本节，但不加载字体文件，只依赖读者本机字体。
- **编辑器字号选项**：14 / 16 / 18 / 20 / 24px，都在规范内，存成 px 的 mark。
