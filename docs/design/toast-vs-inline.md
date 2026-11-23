# 13. 反馈：toast 还是内联

这是主流设计系统的共识，不是本项目自创的规则：toast（本应用自己的实现，经 `components/ui/toast.tsx` 的 `useAppToast` 使用）只确认用户刚做完的一个动作，不携带需要用户处理的错误。

- Shopify Polaris [Toast](https://polaris-react.shopify.com/components/internal-only/toast) — 动作之后的反馈；避免用 toast 呈现错误，需要持续存在的错误放在受影响区域自己的 [Banner](https://polaris.shopify.com/components/banner) 里。
- Atlassian [Messages 模式](https://atlassian.design/patterns/messages/)：只需要最小交互的确认用 [Flag](https://atlassian.design/components/flag)；需要用户处理或重要信息用 [Inline message](https://atlassian.design/components/inline-message)，放在受影响区域里。
- Material 3 [Snackbar 规范](https://m3.material.io/components/snackbar/guidelines)：一行文字，最多一个操作，打断最小，不要求用户操作，一次只显示一条。
- NN/g [错误提示指南](https://www.nngroup.com/articles/error-message-guidelines/)：只有最小交互成本的问题才适合用 toast/banner；用户必须看到或必须处理的错误留在页面内、持续显示。

CoForge 的应用：

- 用户必须看到、必须处理、或者导航离开再回来还要能找到的状态，一律内联显示在受影响的区域里：进行中状态带 spinner 并禁用控件、失败要给出原因和重试、离线的 Computer、字段校验。
- toast 最多是一行确认文字。
- toast 至多带一个操作，只能是下面两种之一，仍是一行文字，不加第二个操作。
  - 「撤销」：可以撤销的动作（关闭会话、从收藏中移除、清空笔记）不先确认，立即执行，toast 带「撤销」。撤销已不适用时（例如清空后又改了内容）收起这条 toast。
  - 紧接刚完成动作、可以立即做的后续动作：保存运行中 Agent 的运行时配置后，配置在 Agent 下次空闲时生效，toast 带「立即重启」。这个动作是可选的，不点也不会丢失任何东西；必须处理的事仍然内联显示，「立即重启」失败时在 Agent 的面板里内联显示原因。
  - 「打开」：结果出现在用户看不到的地方（在别的会话里建了任务），toast 带「打开」直达它。
- toast 分三种：状态（只说结果，3–5 秒按长度）、带操作（6 秒，撤销按需更长，撤销用倒计时环）、进行中（spinner 一直显示，原地变成结果）。离开页面不影响进行中 toast 落到结果。
- 屏幕上一次只有一条 toast。当前一条带操作（撤销、打开）时，新的排队等它结束，免得撤销被顶掉；不带操作时新的直接替换。报错和新的撤销不排队：报错要马上被看到，新的撤销替换旧的撤销（最想撤回的是刚做的那步）。同一件事（同 id）原地更新。
- 通知卡片（`components/ui/notice-card.tsx` 的 `appNotice`）只用于系统事件：新版本、后台任务完成，以后的安全与账单。消息不弹卡片，由系统通知和 Activity 承担。卡片单张显示，多张时带翻页。
- 同一件事不能同时用两种方式呈现。
- 不显示原始错误码或线路字符串。
- 错误参考编号只能出现在内联失败说明下方的一行灰色小字里。

范例：Computer 升级（进行中用进行中 toast 胶囊跟住进度并在页内禁用按钮、显示目标版本；成功后胶囊原地变为完成并更新版本号；失败收起胶囊，用通知卡片提醒并可回到电脑，页内在版本旁保留无框失败提示与重新升级按钮，不发错误 toast）与 Computer 重启（只用 toast，不留内联状态）。
