# Lenovo / corporate egress — values filled by render-lenovo-proxy.sh at start.
# shellcheck shell=sh
if [ -f /etc/coforge/corp-proxy.env ]; then
  # shellcheck disable=SC1091
  . /etc/coforge/corp-proxy.env
fi
