import { isValidReleaseFeedUrl } from "#src/server/install/install-script.server";
import { ServerConnectionError } from "#src/server/workspaces/server-connection.server";

export type HostBootstrapInput = {
  origin: string;
  releaseFeed: string;
  token: string;
  /** The node key already bound to this deployment. Null until the first registration. */
  nodeKey: string | null;
  clusterName: string;
  image: string;
};

/** One script the Swarm manager runs. It carries the cluster token and does not print it. */
export function hostBootstrapScript(input: HostBootstrapInput): string {
  const origin = requireOrigin(input.origin);
  if (!isValidReleaseFeedUrl(input.releaseFeed)) {
    throw new ServerConnectionError(422, "invalid release feed");
  }
  const token = requireShellValue(input.token, 16, "invalid cluster token");
  const nodeKey =
    input.nodeKey === null ? "" : requireShellValue(input.nodeKey, 1, "invalid node key");
  const clusterName = requireShellValue(input.clusterName, 1, "invalid cluster name");
  const image = requireImage(input.image);
  return `#!/bin/sh
# Installs this deployment's host as a system service. The cluster token is in this file.
# It does not replace ~/.local/bin/coforge-computer.
set -eu

feed='${input.releaseFeed}'
origin='${origin}'
token='${token}'
bound_node_key='${nodeKey}'
cluster_name='${clusterName}'
image='${image}'

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
`;
}

function requireOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServerConnectionError(422, "invalid install origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ServerConnectionError(422, "invalid install origin");
  }
  return value;
}

function requireShellValue(value: string, minimum: number, message: string): string {
  const text = value.trim();
  if (!new RegExp(`^[A-Za-z0-9_-]{${minimum},200}$`).test(text)) {
    throw new ServerConnectionError(422, message);
  }
  return text;
}

function requireImage(value: string): string {
  const image = value.trim();
  if (!/^[A-Za-z0-9_.:/-]{1,200}$/.test(image) || /\s/.test(image)) {
    throw new ServerConnectionError(422, "invalid computer image");
  }
  return image;
}
