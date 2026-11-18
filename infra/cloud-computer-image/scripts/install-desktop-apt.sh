#!/usr/bin/env bash
# Terminal toolkit, Node, and a slim XFCE desktop. TigerVNC stays stopped until
# a client connects. Port 5901 is raw VNC. Port 6080 is the browser WebSocket.
# novnc's Python stack (numpy, websockify, oslo) is removed after install; the
# image serves /usr/share/novnc itself.
set -eux

if [ -n "${APT_MIRROR}" ]; then
  . /etc/os-release
  codename="${VERSION_CODENAME:-bookworm}"
  security_mirror="${APT_SECURITY_MIRROR:-${APT_MIRROR}-security}"
  rm -f /etc/apt/sources.list.d/debian.sources \
        /etc/apt/sources.list.d/debian-security.sources \
        /etc/apt/sources.list.d/*.sources 2>/dev/null || true
  printf '%s\n' \
    "deb ${APT_MIRROR} ${codename} main contrib non-free non-free-firmware" \
    "deb ${APT_MIRROR} ${codename}-updates main contrib non-free non-free-firmware" \
    "deb ${security_mirror} ${codename}-security main contrib non-free non-free-firmware" \
    > /etc/apt/sources.list
  echo "Using APT mirror: ${APT_MIRROR}"
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gzip \
  gnupg \
  git \
  jq \
  procps \
  iproute2 \
  fd-find \
  file \
  less \
  nano \
  vim-tiny \
  ripgrep \
  dbus-x11 \
  fonts-dejavu-core \
  fonts-noto-cjk \
  tigervnc-standalone-server \
  novnc \
  librsvg2-bin \
  xfce4-session \
  xfwm4 \
  xfdesktop4 \
  xfce4-panel \
  thunar \
  xfce4-terminal \
  python3-gi \
  python3-pip \
  python3-venv \
  python3-xlib \
  gir1.2-gtk-3.0 \
  chromium

mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs
ln -sf /usr/bin/fdfind /usr/local/bin/fd

for pkg in \
     python3-novnc python3-numpy python3-websockify websockify \
     python3-oslo.config python3-oslo.context python3-oslo.i18n \
     python3-oslo.log python3-oslo.serialization python3-oslo.utils \
     gnupg; do
  if dpkg -s "$pkg" >/dev/null 2>&1; then dpkg --force-depends --purge "$pkg"; fi
done

rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
