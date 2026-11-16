---
name: cloud-computer-overview
description: Map CoForge/Cube cloud-computer resources (shell, /workspace, Chromium, VNC/noVNC, CDP, Playwright, common ports). Use when unsure what tools exist, before refusing a task, or when exploring how to solve a new request on this machine.
---

# 云电脑资源地图

你在 CoForge / Cube 云电脑里。先用本 skill 搞清「有什么、怎么用」，再动手；不要凭通用聊天助手的先验说做不到。

## 快速自检

```bash
echo "DISPLAY=$DISPLAY USER=$(id -un) PWD=$PWD"
command -v chromium coforge-chromium coforge-cdp-endpoint python3 node npm rg fd pi
python3 -c "import playwright; print('playwright ok')" 2>/dev/null || echo "playwright not installed"
ls -la /workspace /workspace/uploads /workspace/browser-shots 2>/dev/null || true
[ -n "${DISPLAY:-}" ] && coforge-cdp-endpoint || echo "DISPLAY unset"
```

## 资源一览

| 资源 | 位置 / 端口 | 用途 |
|---|---|---|
| 工作区 | `/workspace` → 卷 `/root/.coforge/workspace` | 代码与任务文件；换镜像保留 |
| 上传 | `/workspace/uploads` | 用户上传 |
| 截图 | `/workspace/browser-shots` | 浏览器/桌面截图落盘 |
| Python venv | `/root/.coforge/venv` | 运行时 `pip install` 装这里；换镜像保留 |
| 显示 | 任务注入的 `DISPLAY`（每 agent 一路，常为 `:20+`；**不是**默认 `:0`） | X11 桌面 |
| Chromium | `coforge-chromium`（`chromium` 为其包装） | GUI；CDP 经 token 门控 |
| 本路 CDP | `coforge-cdp-endpoint` | 打印可连接的基址 URL |
| Playwright | 不预装；`pip install` 进 venv | `connect_over_cdp(coforge-cdp-endpoint 输出)`；勿 `playwright install`、勿装进系统盘 |
| 填表辅助 | `/usr/local/bin/page-fill.py` | 经 token 化 CDP 填字段；`--inspect` 列出可见输入框 |

## 隔离提醒（防串台）

- 公共口 `9222+显示号` **必须**带 `/coforge-cdp/<token>/`；裸连返回 403。
- **禁止**扫描并附着任意调试口；**禁止** `DISPLAY=:0` 回退。
- 无 `DISPLAY` → 不要开 GUI 浏览器。

## 选型指引

1. **命令行能完成** → 直接 shell。
2. **需要登录/注册/点网页** → 遵循 `browser-login`。
3. **需要确认页面** → 截图到 `/workspace/browser-shots`。
4. **不确定** → 先自检再选路径。

## 探索顺序（新任务）

1. 读任务相关本地文档 / README。
2. `rg` 仓库与 `/usr/local` 是否已有脚本。
3. 跑上面的自检，确认**自己的**桌面与 CDP。
4. 选最小可行路径执行。
