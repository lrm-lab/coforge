---
name: browser-login
description: Log in, register, or operate websites on this CoForge cloud computer using Chromium, CDP, or Playwright. Use when the user asks to open a site, sign in, sign up, fill forms, click through a web UI, or when you would otherwise say you cannot use a browser. Also use when a browser-native HTTP auth dialog appears, or when choosing Forms login vs Negotiate/NTLM on intranet sites.
---

# 云电脑浏览器登录 / 注册

本机有图形桌面与系统 Chromium。网站登录、注册、填表是常规能力。不要回答「我无法打开网页 / 无法登录」。

## 两种登录形态（必须先分清）

### 1. 浏览器原生认证框（HTTP Basic / NTLM / Negotiate）

- 浏览器自己的悬浮对话框，**不是**网页 DOM。外观常见：居中白框标题 `Sign in`、副标题是站点域名、Username/Password、蓝色 Sign in / Cancel——**即使看起来像表单，也不是 HTML**。
- URL 硬信号：路径含 `/adfs/ls/wia`、`/wia`，或响应 `401` + `WWW-Authenticate: Negotiate|NTLM|Basic`。
- 网页脚本和 `page:fill` / `page-fill.py` **都读不到、填不了**这个框。
- 依赖本机域票据。Linux 云电脑**没有** Windows 域票据，这条路径会一直弹框或直接失败。
- **禁止**对原生认证框发 `page:fill`。
- **禁止**对同一 WIA/原生框 URL 反复 `reload` / 刷新 / 重开同一地址——只会再次弹出原生框，不会变成表单。

### 2. 网页嵌入表单（Forms Authentication）

- 页面上的 HTML 用户名/密码（及 OTP）输入框（可用 DevTools / `page-fill.py --inspect` 看到 input）。
- 可用 `page:fill` / `page-fill.py --inspect`。
- 与是否在域电脑无关，适合云电脑、远程、非 Windows。

**云电脑默认选表单。** 同时提供「集成/域登录」和「账号密码/表单登录」时，选后者；不要跟着公司 Windows 无感 Negotiate 路径走。

## 遇到原生框时怎么切到 Forms（必须按序，禁止刷新死循环）

1. **认出是原生框**（上节外观 / `/wia` / 401 Negotiate），立刻停止刷新与对原生框 `page:fill`。
2. **联想 ADFS**：原生框往往是服务端按「浏览器 UA」强制给的；Cancel 或去掉 `/wia` 再开，**仍可能一直 302 回 `/wia`**，不会自动变成表单。
3. **要调出 HTML Forms**：按 `lenovo-intranet`，对登录导航临时把 User-Agent 设为非浏览器（如 `curl/8.0`），再打开预热入口；确认 `page-fill.py --inspect` 能看到 `userNameInput` / `passwordInput` 后 `page:fill`；登录成功后恢复正常 Chrome UA，再回业务 URL。
4. 仍只有原生框：`desktop:takeover`；**不要**刷新重试。

## 认证时机不固定

认证门可能出现在：**首屏、点链接后、SSO 跳转中、cookie 过期后中途**。不要假设「只在打开首页时登录一次」。

处置分两层：

1. **预登录（内网任务必须）**：目标是内网/SSO 且尚无已登录会话时，**先**按 `lenovo-intranet` 做 Forms 预登录。联想 ADFS **按 User-Agent 分流**：普通 Chrome UA 只会进 `/wia` 原生框，**Cancel/刷新都往往出不了 HTML 表单**；登录导航须临时把 UA 设成非浏览器（如 `curl/8.0`）才能直接拿到 HTML Forms，再 `page:fill`，登录成功后恢复正常 UA，**然后**打开业务 URL。
2. **中途再判**：再遇原生框 / `/wia` → **禁止刷新**；按 `lenovo-intranet` 用非浏览器 UA 重做预登录，或 `desktop:takeover`。填完回到原业务 URL。

## 不要做的事

- **不要** `playwright install` / `playwright install chromium`（使用系统 Chromium；环境已跳过浏览器下载）
- **不要** `export DISPLAY=:0` 或任意猜显示号
- **不要** `ps`/`ss` 扫全机调试口再 `connect_over_cdp`——无 token 会 403，且可能是别人的桌面
- **不要** 手算 `9222+显示号` 后裸连 `http://127.0.0.1:端口`（缺 `/coforge-cdp/<token>/` 会被拒绝）
- **不要** 对浏览器原生认证框使用 `page:fill`
- **不要** 对 `/adfs/ls/wia` 或原生 Sign in 框反复刷新 / 重开同一 URL
- **不要** 在聊天里索要或接收后键入密码

## 执行前（必须）

```bash
echo "DISPLAY=${DISPLAY:-unset}"
command -v chromium coforge-chromium coforge-cdp-endpoint python3
python3 -c "from playwright.sync_api import sync_playwright; print('playwright ok')"
mkdir -p /workspace/browser-shots
```

`python3` 应能直接 `import playwright`（镜像已 bake 客户端；venv 可见系统 site-packages）。**不要**再 `pip install playwright`，也**不要** `playwright install`。其他包需要时用阿里云源，**不要** `PIP_BREAK_SYSTEM_PACKAGES=1 pip3 install`。

## 联想内网站点

- 入口 URL、CA/代理、Forms 预登录：加载 skill `lenovo-intranet`。
- 登录：优先 Forms 表单 + `page:fill`；原生认证框出现时按上文切 Forms，不要硬填。填不了（无 Forms 入口、OAuth、图形验证码）再用 `desktop:takeover`。
- **不要**让用户把密码发到聊天里。不要把密码写进镜像或世界可读文件。

- **`DISPLAY` 必须已由任务注入**。若 unset：停止 GUI 浏览器操作并说明原因；**禁止**回退到 `:0`。
- CDP 基址：`endpoint="$(coforge-cdp-endpoint)"`（失败则先启动 `coforge-chromium`）。

## 推荐路径（按优先级）

### A. 桌面 Chromium（适合登录、注册、需要真人可见的流程）

```bash
nohup coforge-chromium --new-window "https://EXAMPLE/" \
  >/tmp/coforge-chromium.log 2>&1 &
endpoint="$(coforge-cdp-endpoint)"
curl -sf "${endpoint}json/list" | head
```

然后用 Playwright：`connect_over_cdp(endpoint)`（`endpoint` 必须来自 `coforge-cdp-endpoint`）。

### B. Playwright 直连（适合可脚本化的表单）

```python
import os
import subprocess
from playwright.sync_api import sync_playwright

display = os.environ.get("DISPLAY") or ""
if not display:
    raise SystemExit("DISPLAY unset; refuse to launch browser (avoid cross-agent desktop)")

def my_endpoint():
    return subprocess.check_output(["coforge-cdp-endpoint"], text=True).strip()

with sync_playwright() as p:
    try:
        browser = p.chromium.connect_over_cdp(my_endpoint())
    except Exception:
        # 本路尚无浏览器时再启动；仍依赖当前 DISPLAY
        subprocess.Popen(["coforge-chromium", "--new-window", "about:blank"])
        browser = p.chromium.connect_over_cdp(my_endpoint())
    page = browser.contexts[0].new_page() if browser.contexts else browser.new_page()
    page.goto("https://EXAMPLE/")
```

### C. 已打开页面上的敏感填表（仅 HTML 表单）

先确认是嵌入表单（DOM 里有账号/密码框）。若是原生认证框，先切 Forms，再走本步。

1. 需要账号/密码时发 `page:fill` 卡片（只需 `id`/`label`/`input`，不必硬猜 CSS）：

```bash
coforge action prepare --target "@owner" <<'COFORGEACTION'
{"type":"page:fill","prompt":"Sign in","fields":[{"id":"username","label":"Username","input":"text"},{"id":"password","label":"Password","input":"password"}]}
COFORGEACTION
```

2. 需要看页面上有哪些格子时：`python3 /usr/local/bin/page-fill.py --inspect`
3. OAuth / 图形验证码 / 无 Forms 入口 / 填不了：发 `desktop:takeover`，并说明 Linux 云电脑无域票据、原生认证框无法自动填。
4. **禁止**在聊天里索要密码；即使用户发来了，也不要键入，改推卡片。

多种**网页内**登录方式时可用 `choice`；云电脑场景默认偏向「账号密码 / Forms」，不要默认选集成 Windows 登录。

## 操作清单

1. 确认 `DISPLAY` → `coforge-cdp-endpoint`。
2. 内网任务：**必须先**按 `lenovo-intranet` Forms 预登录（临时非浏览器 UA → HTML 表单 → `page:fill` → 恢复 UA），再打开业务 URL。
3. 中途再遇原生框 / `/wia` → 禁止刷新；改 UA 重登或 `desktop:takeover`；表单 → `page:fill`；回到业务 URL。
4. 卡片 `[action card: executed]` 后继续提交；若任务被认证打断，回到原目标 URL 继续。
5. 重要导航后再快速检查是否又要认证。
6. 截图或 DOM 检查确认成功；简短回报。

## 硬规则

- 未做上述探测前，禁止说没有浏览器或无法登录。
- 无 `DISPLAY` 时禁止打开/附着 GUI 浏览器。
- 只使用 `coforge-cdp-endpoint` 的 URL 做 CDP。
- 不要把完整密码回显到聊天或写入世界可读日志。
- 不要要求用户把密码粘贴到对话里。
- 不要对浏览器原生 HTTP/Negotiate/NTLM 认证框使用 `page:fill`。
- 不要对 `/adfs/ls/wia` 或原生 Sign in 框反复刷新；按 `lenovo-intranet` 用非浏览器 UA 调出 HTML Forms，或 `desktop:takeover`。
