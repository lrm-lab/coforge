# Swarm computer image. See AGENTS.md.

ARG SANDBOX_IMAGE=cube-sandbox-cn.tencentcloudcr.com/cube-sandbox/sandbox-code@sha256:b551b169de85c0216cce9453a8e22059ca47fd3dceced75e918cf1c8de60464b
FROM ${SANDBOX_IMAGE}

ARG NODE_MAJOR=22
ARG INSTALL_PI=1
ARG PI_SUITE_VERSION=0.1.17
ARG PI_SUITE=npm:@lebronj/pi-suite
ARG PI_WORKSPACE_DIR=/workspace
ARG PI_EVOLUTION_ENABLED=1
ARG NPM_REGISTRY=
ARG APT_MIRROR=https://mirrors.cloud.tencent.com/debian
ARG APT_SECURITY_MIRROR=https://mirrors.cloud.tencent.com/debian-security
ARG COMPUTER_VERSION=
ARG COFORGE_ENVIRONMENT=
ARG COFORGE_RELEASE_FEED_URL=
ARG COFORGE_CLOUD_HOST=

USER root

ENV HOME=/root \
    PYTHONUNBUFFERED=1 \
    COFORGE_CLOUD_COMPUTER=1 \
    COFORGE_ENVIRONMENT=${COFORGE_ENVIRONMENT} \
    COFORGE_RELEASE_FEED_URL=${COFORGE_RELEASE_FEED_URL} \
    COFORGE_CLOUD_HOST=${COFORGE_CLOUD_HOST} \
    PI_WEB_HOST=0.0.0.0 \
    PI_WEB_PORT=6079 \
    PI_WEB_WORKSPACE=/workspace \
    PI_WEB_TERM_SHELL=/bin/bash \
    PI_WEB_CONSOLE=0 \
    NODE_EXTRA_CA_CERTS=/root/.pi/agent/certs/lenovo-modelfactory-ca.pem \
    LENOVO_MODELFACTORY_HOST=modelfactory.lenovo.com \
    LENOVO_MODELFACTORY_IP=10.110.158.101 \
    LENOVO_DEEPSEEK_PROVIDER=modelfactoryllm \
    LENOVO_DEEPSEEK_MODEL=DeepSeek \
    LENOVO_DEEPSEEK_BASE_URL=https://modelfactory.lenovo.com/llm/v1 \
    LENOVO_DEEPSEEK_AS_DEFAULT=1 \
    NODE_OPTIONS=--require=/usr/local/lib/lenovo-modelfactory-dns-hook.js \
    PATH=/root/.local/bin:/root/.npm-global/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin

COPY scripts/install-desktop-apt.sh /tmp/install-desktop-apt.sh
RUN chmod +x /tmp/install-desktop-apt.sh \
  && /tmp/install-desktop-apt.sh \
  && rm -f /tmp/install-desktop-apt.sh

# Bake into /usr/bin/python3 (3.11): PATH prefers sandbox 3.12; runtime venv
# uses --system-site-packages on 3.11. Playwright is client-only
# (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD); agents CDP to system Chromium.
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG PIP_TRUSTED_HOST=mirrors.aliyun.com
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}
COPY requirements.txt /tmp/requirements.txt
RUN set -eux; \
  printf '%s\n' \
    '[global]' \
    "index-url = ${PIP_INDEX_URL}" \
    "trusted-host = ${PIP_TRUSTED_HOST}" \
    'timeout = 60' \
    > /etc/pip.conf; \
  mkdir -p /root/.config/pip; \
  cp /etc/pip.conf /root/.config/pip/pip.conf; \
  pip_args="--no-cache-dir --break-system-packages"; \
  if [ -n "${PIP_INDEX_URL}" ]; then \
    pip_args="${pip_args} -i ${PIP_INDEX_URL}"; \
  fi; \
  if [ -n "${PIP_TRUSTED_HOST}" ]; then \
    pip_args="${pip_args} --trusted-host ${PIP_TRUSTED_HOST}"; \
  fi; \
  # shellcheck disable=SC2086
  /usr/bin/python3 -m pip install ${pip_args} -r /tmp/requirements.txt; \
  /usr/bin/python3 -c 'from playwright.sync_api import sync_playwright'; \
  rm -f /tmp/requirements.txt

COPY lenovo-modelfactory-ca.pem /root/.pi/agent/certs/lenovo-modelfactory-ca.pem
COPY scripts/lenovo-modelfactory-dns-hook.js /usr/local/lib/lenovo-modelfactory-dns-hook.js

RUN mkdir -p /workspace /root/.npm-global /root/.pi/agent/certs \
  && chmod 644 /root/.pi/agent/certs/lenovo-modelfactory-ca.pem \
  && printf '%s\n' \
       'export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/root/.pi/agent/certs/lenovo-modelfactory-ca.pem}"' \
       > /etc/profile.d/lenovo-modelfactory-ca.sh \
  && chmod 644 /etc/profile.d/lenovo-modelfactory-ca.sh \
  && chown -R root:root /workspace /root/.npm-global /root/.pi \
  && chmod 755 /workspace

WORKDIR /workspace

COPY coforge/coforge-computer /usr/local/bin/coforge-computer
LABEL org.coforge.computer.version=${COMPUTER_VERSION}
COPY scripts/bake-pi-deepseek.sh /usr/local/bin/bake-pi-deepseek.sh
COPY scripts/container-systemctl /usr/local/bin/systemctl
COPY config/pi-modelfactory-provider.json /usr/local/share/coforge/pi-modelfactory-provider.json
COPY config/pi-braimaster-provider.json /usr/local/share/coforge/pi-braimaster-provider.json
COPY config/pi-agent/APPEND_SYSTEM.md /usr/local/share/coforge/pi-APPEND_SYSTEM.md
COPY config/pi-agent/skills/ /usr/local/share/coforge/pi-skills/
RUN chmod 755 /usr/local/bin/coforge-computer \
  /usr/local/bin/bake-pi-deepseek.sh \
  /usr/local/bin/systemctl \
  && chmod 644 /usr/local/share/coforge/pi-APPEND_SYSTEM.md \
  /usr/local/share/coforge/pi-modelfactory-provider.json \
  /usr/local/share/coforge/pi-braimaster-provider.json \
  && find /usr/local/share/coforge/pi-skills -type f -name 'SKILL.md' -exec chmod 644 {} +

COPY scripts/install-pi.sh /tmp/install-pi.sh
RUN chmod +x /tmp/install-pi.sh \
  && /tmp/install-pi.sh \
  && rm -f /tmp/install-pi.sh

RUN ln -sf /root/.npm-global/bin/pi /usr/local/bin/pi.real \
  && printf '%s\n' \
       '#!/usr/bin/env bash' \
       'export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/root/.pi/agent/certs/lenovo-modelfactory-ca.pem}"' \
       'export NODE_OPTIONS="${NODE_OPTIONS:---require=/usr/local/lib/lenovo-modelfactory-dns-hook.js}"' \
       'exec /usr/local/bin/pi.real "$@"' \
       > /usr/local/bin/pi \
  && chmod +x /usr/local/bin/pi \
  && ln -sf /root/.npm-global/bin/pi-mcp-adapter /usr/local/bin/pi-mcp-adapter || true

# Remove the non-root working account inherited from the Cube base image. System
# accounts such as nobody/daemon remain because Debian packages may rely on them.
RUN userdel -r user 2>/dev/null || true \
  && rm -rf /home/user

RUN printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/coforge-computer __agent-cli "$@"' \
      > /usr/local/bin/coforge \
  && chmod 755 /usr/local/bin/coforge

# Optional host snapshot of Pi agent files. Copied first so the bake step below
# always overwrites apiKey from LENOVO_BRAIMASTER_* / LENOVO_DEEPSEEK_* (pi.env).
# APPEND_SYSTEM.md and skills are always installed from share templates so Pi
# knows it is a CoForge cloud-computer agent with browser/desktop capabilities.
COPY config/pi-agent/ /tmp/pi-agent/
RUN mkdir -p /root/.pi/agent/certs /root/.pi/agent/skills \
  && cp /usr/local/share/coforge/pi-APPEND_SYSTEM.md /root/.pi/agent/APPEND_SYSTEM.md \
  && chmod 644 /root/.pi/agent/APPEND_SYSTEM.md \
  && for skill_name in cloud-computer-overview browser-login; do \
       rm -rf "/root/.pi/agent/skills/${skill_name}"; \
       cp -a "/usr/local/share/coforge/pi-skills/${skill_name}" "/root/.pi/agent/skills/${skill_name}"; \
     done \
  && if [ -f /tmp/pi-agent/models.json ]; then \
      cp /tmp/pi-agent/models.json /root/.pi/agent/models.json; \
      if [ -f /tmp/pi-agent/settings.json ]; then cp /tmp/pi-agent/settings.json /root/.pi/agent/settings.json; fi; \
      if [ -d /tmp/pi-agent/certs ]; then cp -a /tmp/pi-agent/certs/. /root/.pi/agent/certs/; fi; \
      chmod 600 /root/.pi/agent/models.json; \
      chmod 644 /root/.pi/agent/certs/* 2>/dev/null || true; \
    fi; \
    rm -rf /tmp/pi-agent

# Bake after the snapshot copy so a stale config/pi-agent/models.json cannot
# clobber the keys from pi.env.
ARG LENOVO_DEEPSEEK_V4_FLASH_API_KEY
ARG LENOVO_DEEPSEEK_PROVIDER=modelfactoryllm
ARG LENOVO_DEEPSEEK_MODEL=DeepSeek
ARG LENOVO_DEEPSEEK_BASE_URL=https://modelfactory.lenovo.com/llm/v1
ARG LENOVO_DEEPSEEK_MODEL_NAME=DeepSeek
ARG LENOVO_DEEPSEEK_AS_DEFAULT=1
RUN if [ "${INSTALL_PI}" != "1" ]; then \
      echo "Skipping Lenovo LLM bake (INSTALL_PI=${INSTALL_PI})"; \
    elif [ -z "${LENOVO_DEEPSEEK_V4_FLASH_API_KEY}" ]; then \
      echo "ERROR: LENOVO_DEEPSEEK_V4_FLASH_API_KEY build-arg is required to bake modelfactoryllm/DeepSeek" >&2; \
      exit 1; \
    else \
      LENOVO_DEEPSEEK_V4_FLASH_API_KEY="${LENOVO_DEEPSEEK_V4_FLASH_API_KEY}" \
      LENOVO_DEEPSEEK_PROVIDER="${LENOVO_DEEPSEEK_PROVIDER}" \
      LENOVO_DEEPSEEK_MODEL="${LENOVO_DEEPSEEK_MODEL}" \
      LENOVO_DEEPSEEK_BASE_URL="${LENOVO_DEEPSEEK_BASE_URL}" \
      LENOVO_DEEPSEEK_MODEL_NAME="${LENOVO_DEEPSEEK_MODEL_NAME}" \
      LENOVO_DEEPSEEK_AS_DEFAULT="${LENOVO_DEEPSEEK_AS_DEFAULT}" \
      /usr/local/bin/bake-pi-deepseek.sh; \
      test -f /root/.pi/agent/models.json; \
      test -f /root/.pi/agent/settings.json; \
      test -f /root/.pi/agent/model-factory.env; \
      test -f /root/.pi/agent/APPEND_SYSTEM.md; \
      grep -q 'CoForge' /root/.pi/agent/APPEND_SYSTEM.md; \
      test -f /root/.pi/agent/skills/cloud-computer-overview/SKILL.md; \
      test -f /root/.pi/agent/skills/browser-login/SKILL.md; \
      grep -q 'name: browser-login' /root/.pi/agent/skills/browser-login/SKILL.md; \
      grep -q 'https://modelfactory.lenovo.com/llm/v1' /root/.pi/agent/models.json; \
      grep -q '"id": "DeepSeek"' /root/.pi/agent/models.json; \
      grep -q '"id": "gpt-oss-120b"' /root/.pi/agent/models.json; \
      grep -q '"id": "gemma-4-31B-it"' /root/.pi/agent/models.json; \
      grep -q '"id": "GLM-5.3-Flash"' /root/.pi/agent/models.json; \
      grep -q '"id": "Laguna-S-2.1"' /root/.pi/agent/models.json; \
      grep -q '"defaultProvider": "modelfactoryllm"' /root/.pi/agent/settings.json; \
      grep -q '"defaultModel": "DeepSeek"' /root/.pi/agent/settings.json; \
    fi

COPY scripts/persist-user-data.sh /usr/local/bin/persist-user-data.sh
COPY scripts/sync-pi-skills.sh /usr/local/bin/sync-pi-skills.sh
COPY scripts/bind-pi-skills.sh /usr/local/bin/bind-pi-skills.sh
COPY scripts/select-computer-binary.sh /usr/local/bin/select-computer-binary.sh
COPY scripts/activate-computer-release.sh /usr/local/bin/activate-computer-release.sh
COPY scripts/supervise-computer-runtime.sh /usr/local/bin/supervise-computer-runtime.sh
COPY scripts/watch-computer-workspaces.sh /usr/local/bin/watch-computer-workspaces.sh
COPY scripts/restart-computer-runtime.sh /usr/local/bin/restart-computer-runtime.sh
COPY scripts/entrypoint-foreground.sh /usr/local/bin/entrypoint-foreground.sh

COPY scripts/vnc-ondemand.py /usr/local/bin/vnc-ondemand.py
COPY scripts/vnc-websocket.py /usr/local/bin/vnc-websocket.py
COPY scripts/vnc_des.py /usr/local/bin/vnc_des.py
COPY scripts/vnc_bridge.py /usr/local/bin/vnc_bridge.py
COPY scripts/page-fill.py /usr/local/bin/page-fill.py
COPY scripts/page_fill_cdp.py /usr/local/bin/page_fill_cdp.py
COPY scripts/page_fill_dom.py /usr/local/bin/page_fill_dom.py
COPY scripts/page_fill_ws.py /usr/local/bin/page_fill_ws.py
COPY scripts/desktop_clipboard.py /usr/local/bin/desktop_clipboard.py
COPY scripts/vnc-xstartup /usr/local/share/coforge/vnc-xstartup
COPY scripts/vnc-agent-xstartup /usr/local/share/coforge/vnc-agent-xstartup
COPY scripts/vnc-agent-screen.py /usr/local/bin/vnc-agent-screen.py
COPY scripts/vnc-desktop.html /usr/local/share/coforge/vnc-desktop.html
COPY scripts/coforge_cdp.py /usr/local/lib/coforge/coforge_cdp.py
COPY scripts/coforge-chromium.py /usr/local/bin/coforge-chromium
COPY scripts/coforge-cdp-endpoint /usr/local/bin/coforge-cdp-endpoint
COPY scripts/coforge_x11.py /usr/local/lib/coforge/coforge_x11.py
COPY scripts/coforge_dock_policy.py /usr/local/lib/coforge/coforge_dock_policy.py
COPY scripts/coforge-launcher-focus.py /usr/local/bin/coforge-launcher-focus
COPY scripts/coforge-dock-ui.py /usr/local/bin/coforge-dock-ui
COPY scripts/coforge-thunar.sh /usr/local/bin/coforge-thunar
COPY scripts/coforge-terminal /usr/local/bin/coforge-terminal
COPY scripts/coforge-dock /usr/local/bin/coforge-dock
COPY scripts/coforge-maximize-chromium /usr/local/bin/coforge-maximize-chromium
COPY config/desktop-wallpaper-preview.png /usr/local/share/coforge/desktop-logo.png
COPY config/xfce/xfce4-desktop.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml
COPY config/xfce/xfce4-panel.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml
COPY config/xfce/xfwm4.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml
COPY config/xfce/xfce4-session.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml
COPY config/xfce/applications/coforge-chromium.desktop /usr/share/applications/coforge-chromium.desktop
COPY config/xfce/applications/coforge-terminal.desktop /usr/share/applications/coforge-terminal.desktop
COPY config/xfce/applications/coforge-thunar.desktop /usr/share/applications/coforge-thunar.desktop
COPY config/xfce/applications/coforge-text-editor.desktop /usr/share/applications/coforge-text-editor.desktop
COPY config/xfce/mimeapps.list /etc/xdg/mimeapps.list
COPY config/gtk-3.0/gtk.css /etc/xdg/gtk-3.0/gtk.css
COPY config/chromium/policies/managed/coforge.json /etc/chromium/policies/managed/coforge.json
COPY config/chromium/policies/managed/lenovo-intranet.json.template /usr/local/share/coforge/lenovo-intranet.json.template
COPY config/profile.d/corp-proxy.sh /usr/local/share/coforge/corp-proxy.sh
COPY config/certs/lenovo-sha2-root.crt /usr/local/share/ca-certificates/lenovo-sha2-root.crt
COPY config/certs/lenovo-sha2-subca1.crt /usr/local/share/ca-certificates/lenovo-sha2-subca1.crt
COPY scripts/render-lenovo-proxy.sh /usr/local/bin/render-lenovo-proxy.sh
RUN update-ca-certificates \
  && chmod 755 /usr/local/bin/render-lenovo-proxy.sh \
  && chmod 644 /usr/local/share/coforge/lenovo-intranet.json.template \
      /usr/local/share/coforge/corp-proxy.sh \
      /usr/local/share/ca-certificates/lenovo-sha2-root.crt \
      /usr/local/share/ca-certificates/lenovo-sha2-subca1.crt \
  && openssl x509 -in /usr/local/share/ca-certificates/lenovo-sha2-root.crt -noout -subject \
    | grep -q 'SHA2ROOTCA' \
  && openssl x509 -in /usr/local/share/ca-certificates/lenovo-sha2-subca1.crt -noout -subject \
    | grep -q 'lenovoSHA2SUBCA1'
RUN mkdir -p /usr/local/lib/coforge /usr/local/share/coforge \
  && if [ -n "${COMPUTER_VERSION}" ]; then printf '%s\n' "${COMPUTER_VERSION}" > /usr/local/share/coforge/computer-version; fi \
  && chmod 755 /usr/local/bin/persist-user-data.sh \
      /usr/local/bin/sync-pi-skills.sh \
      /usr/local/bin/bind-pi-skills.sh \
      /usr/local/bin/select-computer-binary.sh \
      /usr/local/bin/activate-computer-release.sh \
      /usr/local/bin/supervise-computer-runtime.sh \
      /usr/local/bin/watch-computer-workspaces.sh \
      /usr/local/bin/restart-computer-runtime.sh \
      /usr/local/bin/entrypoint-foreground.sh \
      /usr/local/bin/vnc-ondemand.py \
      /usr/local/bin/vnc-websocket.py \
      /usr/local/bin/vnc_des.py \
      /usr/local/bin/vnc_bridge.py \
      /usr/local/bin/page-fill.py \
      /usr/local/bin/page_fill_cdp.py \
      /usr/local/bin/page_fill_dom.py \
      /usr/local/bin/page_fill_ws.py \
      /usr/local/bin/desktop_clipboard.py \
      /usr/local/bin/vnc-agent-screen.py \
      /usr/local/bin/coforge-chromium \
      /usr/local/bin/coforge-cdp-endpoint \
      /usr/local/lib/coforge/coforge_cdp.py \
      /usr/local/bin/coforge-launcher-focus \
      /usr/local/bin/coforge-dock-ui \
      /usr/local/bin/coforge-thunar \
      /usr/local/bin/coforge-terminal \
      /usr/local/bin/coforge-dock \
      /usr/local/bin/coforge-maximize-chromium \
      /usr/local/share/coforge/vnc-xstartup \
      /usr/local/share/coforge/vnc-agent-xstartup \
  && mkdir -p /usr/local/share/coforge /root/.vnc \
  && ln -sfn /usr/local/share/coforge/vnc-xstartup /root/.vnc/xstartup \
  && rm -rf /root/.cache /root/.npm \
      /usr/bin/envd \
      /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/uvicorn /usr/local/bin/fastapi \
      /usr/local/bin/start-lightweight-code-interpreter.sh \
      /opt/lightweight-code-interpreter \
  && dpkg --purge librsvg2-bin \
  && command -v tigervncserver \
  && command -v startxfce4 \
  && ln -sfn coforge-chromium /usr/local/bin/chromium \
  && command -v chromium \
  && test -f /usr/share/novnc/core/rfb.js \
  && test -f /usr/local/share/coforge/vnc-desktop.html \
  && test -f /usr/local/share/coforge/desktop-logo.png \
  && test -f /etc/chromium/policies/managed/coforge.json \
  && grep -q '"PasswordManagerEnabled": false' /etc/chromium/policies/managed/coforge.json \
  && grep -q 'placement_ratio' /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml \
  && grep -q 'show_dock_shadow' /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml \
  && grep -q 'autohide-size: 48' /etc/xdg/gtk-3.0/gtk.css \
  && grep -q '<property name="panels" type="array">' /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml \
  && ! grep -q '>xfce4-panel<' /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml \
  && test -x /usr/local/bin/coforge-dock-ui \
  && test -f /usr/local/lib/coforge/coforge_dock_policy.py \
  && grep -q 'def dock_hides_when_idle' /usr/local/lib/coforge/coforge_dock_policy.py \
  && grep -q 'return False' /usr/local/lib/coforge/coforge_dock_policy.py \
  && grep -q 'def dock_height_px' /usr/local/lib/coforge/coforge_dock_policy.py \
  && grep -q 'coforge-desktop-phone-bar' /usr/local/share/coforge/vnc-desktop.html \
  && grep -q 'coforge-desktop-keys' /usr/local/share/coforge/vnc-desktop.html \
  && grep -q 'coforgeAttachPhoneGestures' /usr/local/share/coforge/vnc-desktop.html \
  && grep -q 'coforge-desktop-keyboard-input' /usr/local/share/coforge/vnc-desktop.html \
  && grep -q 'coforgeAttachPhoneKeyboard' /usr/local/share/coforge/vnc-desktop.html \
  && test -x /usr/local/bin/coforge-thunar \
  && test -f /usr/share/applications/coforge-text-editor.desktop \
  && test -f /etc/xdg/mimeapps.list \
  && grep -q '^TryExec=nano$' /usr/share/applications/coforge-text-editor.desktop \
  && grep -q '^text/plain=coforge-text-editor.desktop$' /etc/xdg/mimeapps.list \
  && command -v nano \
  && command -v xfce4-terminal \
  && grep -q 'coforge-dock-ui' /usr/local/share/coforge/vnc-xstartup \
  && grep -q 'coforge-dock-ui' /usr/local/share/coforge/vnc-agent-xstartup \
  && grep -q '.coforge-dock' /etc/xdg/gtk-3.0/gtk.css \
  && grep -q -- '--start-maximized' /usr/local/bin/coforge-chromium \
  && grep -q 'coforge-cdp' /usr/local/bin/coforge-chromium \
  && test -x /usr/local/bin/coforge-cdp-endpoint \
  && test -f /usr/local/lib/coforge/coforge_cdp.py \
  && test -x /usr/local/bin/coforge-terminal \
  && test -x /usr/local/bin/coforge-maximize-chromium \
  && test -x /usr/local/bin/persist-user-data.sh \
  && test -x /usr/local/bin/sync-pi-skills.sh \
  && test -x /usr/local/bin/bind-pi-skills.sh \
  && grep -q 'sync-pi-skills.sh' /usr/local/bin/entrypoint-foreground.sh \
  && grep -q 'bind-pi-skills.sh' /usr/local/bin/entrypoint-foreground.sh \
  && grep -q 'COFORGE_CLOUD_COMPUTER' /usr/local/bin/entrypoint-foreground.sh \
  && grep -q 'persist_workspace' /usr/local/bin/persist-user-data.sh \
  && grep -q 'ensure_venv' /usr/local/bin/persist-user-data.sh \
  && /usr/bin/python3 -c 'import venv' \
  && /usr/bin/python3 -c 'import Xlib' \
  && /usr/bin/python3 -c 'from playwright.sync_api import sync_playwright; sync_playwright().start().stop()' \
  && ! ldd /usr/local/lib/python3.*/dist-packages/playwright/driver/node 2>/dev/null | grep -q 'not found' \
  && test -x /usr/local/bin/select-computer-binary.sh \
  && test -x /usr/local/bin/activate-computer-release.sh \
  && test -x /usr/local/bin/supervise-computer-runtime.sh \
  && test -x /usr/local/bin/watch-computer-workspaces.sh \
  && grep -q 'exec "${bin}" foreground' /usr/local/bin/entrypoint-foreground.sh \
  && ! grep -q 'supervise-computer-runtime.sh' /usr/local/bin/entrypoint-foreground.sh \
  && ! grep -q 'watch-computer-workspaces.sh' /usr/local/bin/entrypoint-foreground.sh \
  && test -x /usr/local/bin/restart-computer-runtime.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint-foreground.sh"]

EXPOSE 5901 6080
