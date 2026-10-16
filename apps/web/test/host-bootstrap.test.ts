import { describe, expect, test } from "bun:test";

import { ServerConnectionError } from "#src/server/workspaces/server-connection.server";
import { hostBootstrapScript } from "#src/server/workspaces/host-bootstrap.server";

const token = "a".repeat(32);
const nodeKey = "b".repeat(32);

describe("host bootstrap script", () => {
  test("installs the host binary, env file, and system service without install.sh", () => {
    const script = hostBootstrapScript({
      origin: "https://staging.coforge.cn",
      releaseFeed: "https://releases-staging.coforge.cn",
      token,
      nodeKey,
      clusterName: "staging",
      image: "coforge-computer:staging",
    });

    expect(script).toBe(`#!/bin/sh
# Installs this deployment's host as a system service. The cluster token is in this file.
# It does not replace ~/.local/bin/coforge-computer.
set -eu

feed='https://releases-staging.coforge.cn'
origin='https://staging.coforge.cn'
token='${token}'
bound_node_key='${nodeKey}'
cluster_name='staging'
image='coforge-computer:staging'

umask 077
dir="$HOME/.coforge-host"
mkdir -p "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$feed/latest" -o "$tmp/latest"
version=$(tr -d '[:space:]' < "$tmp/latest")
case "$version" in
  *[!A-Za-z0-9._-]*) echo "host bootstrap: the release feed returned an unusable version" >&2; exit 1 ;;
  ""|latest) echo "host bootstrap: the release feed returned an unusable version" >&2; exit 1 ;;
esac

curl -fsSL "$feed/$version/linux-x64/coforge-computer.gz" -o "$tmp/coforge-computer.gz"
curl -fsSL "$feed/$version/linux-x64/coforge-computer.sha256" -o "$tmp/coforge-computer.sha256"
gzip -dc "$tmp/coforge-computer.gz" > "$dir/coforge-computer"
expected=$(tr -d '[:space:]' < "$tmp/coforge-computer.sha256")
actual=$(sha256sum "$dir/coforge-computer" | awk '{print $1}')
if [ "$actual" != "$expected" ]; then
  echo "host bootstrap: checksum did not match" >&2
  exit 1
fi
chmod 755 "$dir/coforge-computer"

if [ -n "$bound_node_key" ]; then
  node_key=$bound_node_key
elif [ -s "$dir/node-key" ]; then
  node_key=$(tr -d '[:space:]' < "$dir/node-key")
else
  node_key=$(openssl rand -hex 32)
fi
printf '%s\\n' "$node_key" > "$dir/node-key"
chmod 600 "$dir/node-key"

cat > "$dir/host.env" <<EOF
COFORGE_CLUSTER_TOKEN=$token
COFORGE_CLUSTER_NODE_KEY=$node_key
COFORGE_CLUSTER_NAME=$cluster_name
COFORGE_COMPUTER_IMAGE=$image
EOF
chmod 600 "$dir/host.env"

user=$(id -un)
cat > "$tmp/coforge-host.service" <<EOF
[Unit]
Description=CoForge Swarm host
After=docker.service
Wants=docker.service

[Service]
User=$user
Group=$user
SupplementaryGroups=docker
EnvironmentFile=$dir/host.env
ExecStart=$dir/coforge-computer host --server-url $origin
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl --user disable --now coforge-host.service >/dev/null 2>&1 || true
sudo cp "$tmp/coforge-host.service" /etc/systemd/system/coforge-host.service
sudo systemctl daemon-reload
sudo systemctl enable --now coforge-host.service
systemctl is-active coforge-host.service
`);
    expect(script).not.toContain("install.sh");
  });

  test("leaves the node key for the machine to create when none is bound yet", () => {
    const script = hostBootstrapScript({
      origin: "https://staging.coforge.cn",
      releaseFeed: "https://releases-staging.coforge.cn",
      token,
      nodeKey: null,
      clusterName: "staging",
      image: "coforge-computer:staging",
    });

    expect(script).toContain("bound_node_key=''");
    expect(script).toContain("openssl rand -hex 32");
  });

  test("rejects a value that a shell could treat as another command", () => {
    expect(() =>
      hostBootstrapScript({
        origin: "https://staging.coforge.cn",
        releaseFeed: "https://releases-staging.coforge.cn",
        token,
        nodeKey,
        clusterName: "staging",
        image: "coforge computer",
      }),
    ).toThrow(ServerConnectionError);
  });
});
