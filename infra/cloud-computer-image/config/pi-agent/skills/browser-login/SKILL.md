---
name: browser-login
description: Log in, register, or operate websites on this CoForge cloud computer using Chromium, CDP, or Playwright. Use when the user asks to open a site, sign in, sign up, fill forms, click through a web UI, or when you would otherwise say you cannot use a browser.
---

# 云电脑浏览器登录 / 注册

本机有图形桌面与系统 Chromium。网站登录、注册、填表是常规能力。不要回答「我无法打开网页 / 无法登录」。

## 不要做的事

- **不要** `playwright install` / `playwright install chromium`（使用系统 Chromium；环境已跳过浏览器下载）
- **不要** `export DISPLAY=:0` 或任意猜显示号
- **不要** `ps`/`ss` 扫全机调试口再 `connect_over_cdp`——无 token 会 403，且可能是别人的桌面
- **不要** 手算 `9222+显示号` 后裸连 `http://127.0.0.1:端口`（缺 `/coforge-cdp/<token>/` 会被拒绝）

## 执行前（必须）

```bash
echo "DISPLAY=${DISPLAY:-unset}"
command -v chromium coforge-chromium coforge-cdp-endpoint python3
python3 -c "from playwright.sync_api import sync_playwright; print('playwright ok')" 2>/dev/null \
  || pip install -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com playwright
mkdir -p /workspace/browser-shots
```

`pip` / `python3` 应来自 `/root/.coforge/venv`（换镜像可保留）。**不要**用 `PIP_BREAK_SYSTEM_PACKAGES=1 pip3 install` 装进系统盘。
**不要** `pip install … | tail`（大包输出可能看起来像卡住）；直连默认 pypi.org 在本网常会挂死，用上面的阿里云源。

## 联想内网站点

- 连通：镜像已装联想 CA；代理由启动脚本渲染（查看 `/etc/chromium/policies/managed/lenovo-intranet.json` 与 `echo $HTTPS_PROXY`）。
- 登录：用 `coforge-chromium` 打开目标页（如 `https://home.lenovo.com`）。需要密码/验证码时，用 CoForge `page:fill` action card（或本机无法填时用 `desktop:takeover`），**不要**让用户把密码发到聊天里。不要把密码写进镜像或世界可读文件。
- 若页打不开：先 `curl -sI -o /dev/null -w '%{http_code}\n' --connect-timeout 5 https://home.lenovo.com/`，并确认 `HTTPS_PROXY` / 策略里的 ProxyServer 非空。

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

### C. 已打开页面上的敏感填表（优先）

1. 打开登录页后，需要账号/密码时发 `page:fill` 卡片（只需 `id`/`label`/`input`，不必硬猜 CSS）：

```bash
coforge action prepare --target "@owner" <<'COFORGEACTION'
{"type":"page:fill","prompt":"Sign in","fields":[{"id":"username","label":"Username","input":"text"},{"id":"password","label":"Password","input":"password"}]}
COFORGEACTION
```

2. 需要看页面上有哪些格子时：`python3 /usr/local/bin/page-fill.py --inspect`
3. OAuth / 图形验证码 / 填不了：发 `desktop:takeover`，让用户自己打开云电脑。
4. **禁止**在聊天里索要密码；即使用户发来了，也不要键入，改推卡片。

多种登录方式时先发 `choice` 卡片再进入上面步骤。

## 操作清单

1. 确认 `DISPLAY` → `coforge-cdp-endpoint` → 打开目标 URL。
2. 识别登录/注册入口并进入表单；多路径用 `choice`。
3. 缺凭证 → `page:fill`（或 `desktop:takeover`）；不要让用户把密码打进聊天。
4. 卡片 `[action card: executed]` 后继续提交或后续步骤。
5. 截图或 DOM 检查确认成功。
6. 简短回报结果。

## 硬规则

- 未做上述探测前，禁止说没有浏览器或无法登录。
- 无 `DISPLAY` 时禁止打开/附着 GUI 浏览器。
- 只使用 `coforge-cdp-endpoint` 的 URL 做 CDP。
- 不要把完整密码回显到聊天或写入世界可读日志。
- 不要要求用户把密码粘贴到对话里。
