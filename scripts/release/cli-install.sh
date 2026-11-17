#!/bin/sh
set -eu
default_feed_url="https://releases.coforge.cn"
feed_url=${COFORGE_RELEASE_FEED_URL:-$default_feed_url}
feed_url=${feed_url%/}
version=latest
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "cli-install.sh: --version requires a value" >&2; exit 2; }
      version=$2
      shift 2
      ;;
    -h|--help)
      echo "usage: cli-install.sh [--version <version>]" >&2
      exit 0
      ;;
    *)
      echo "cli-install.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
is_valid_version() {
  case "$1" in
    "") return 1 ;;
    .) return 1 ;;
    *..*) return 1 ;;
    -*) return 1 ;;
    *[!A-Za-z0-9.+-]*) return 1 ;;
  esac
  [ "${#1}" -le 100 ]
}
if [ "$version" != "latest" ] && ! is_valid_version "$version"; then
  echo "cli-install.sh: version must be latest or a valid version string" >&2
  exit 2
fi
case "$feed_url" in
  https://*) curl_proto='=https' ;;
  http://*)
    [ "${COFORGE_INSTALLER_TEST_MODE:-}" = "1" ] || {
      echo "cli-install.sh: COFORGE_RELEASE_FEED_URL must use HTTPS" >&2
      exit 2
    }
    curl_proto='=http,https'
    ;;
  *)
    echo "cli-install.sh: COFORGE_RELEASE_FEED_URL must use HTTPS" >&2
    exit 2
    ;;
esac
command -v curl >/dev/null 2>&1 || { echo "cli-install.sh: curl is required" >&2; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo "cli-install.sh: gzip is required" >&2; exit 1; }
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Darwin-arm64) target=darwin-arm64 ;;
  *) echo "cli-install.sh: unsupported platform" >&2; exit 1 ;;
esac
bin_directory=${COFORGE_BIN_DIR:-$HOME/.local/bin}
max_pointer_bytes=4096
max_manifest_bytes=1048576
max_binary_bytes=536870912
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/coforge-cli-install.XXXXXX")
staged_path=
cleanup() {
  rm -rf "$temporary_directory"
  [ -z "$staged_path" ] || rm -f "$staged_path"
}
trap cleanup EXIT HUP INT TERM
fetch() {
  curl --fail --silent --show-error --proto "$curl_proto" --tlsv1.2 "$@" || {
    echo "cli-install.sh: download failed: $*" >&2
    return 1
  }
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}
is_sha256() {
  case "$1" in
    *[!a-f0-9]*) return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}
if [ "$version" = "latest" ]; then
  fetch --max-filesize "$max_pointer_bytes" --output "$temporary_directory/latest" "$feed_url/latest"
  version=$(tr -d '[:space:]' < "$temporary_directory/latest")
  if [ "$version" = latest ] || ! is_valid_version "$version"; then
    echo "cli-install.sh: invalid latest pointer" >&2
    exit 1
  fi
fi
release_url="$feed_url/$version"
fetch --max-filesize "$max_manifest_bytes" --output "$temporary_directory/manifest.json" "$release_url/manifest.json"
manifest_sha256=$(awk -v target="$target" '
  /^  "cli": \{/ { in_cli = 1; next }
  in_cli && /^  \}/ { in_cli = 0 }
  in_cli && $0 == "    \"" target "\": {" { in_target = 1; next }
  in_cli && in_target && /^    \}/ { in_target = 0 }
  in_cli && in_target && /^      "checksum": "/ { gsub(/.*: "|",?$/, ""); print; exit }
' "$temporary_directory/manifest.json")
if ! is_sha256 "$manifest_sha256"; then
  echo "cli-install.sh: release $version does not publish a standalone CLI for $target" >&2
  exit 1
fi
target_url="$release_url/$target"
fetch --max-filesize "$max_pointer_bytes" --output "$temporary_directory/coforge.sha256" "$target_url/coforge.sha256"
sidecar_sha256=$(tr -d '[:space:]' < "$temporary_directory/coforge.sha256")
if ! is_sha256 "$sidecar_sha256"; then
  echo "cli-install.sh: sidecar checksum for $target is missing or malformed" >&2
  exit 1
fi
[ "$sidecar_sha256" = "$manifest_sha256" ] || {
  echo "cli-install.sh: sidecar and manifest checksums disagree for $target" >&2
  exit 1
}
echo "Downloading coforge $version ($target)" >&2
fetch --location --proto-redir "$curl_proto" --max-filesize "$max_binary_bytes" --output "$temporary_directory/coforge.gz" "$target_url/coforge.gz"
(ulimit -f 1048576; gzip -dc "$temporary_directory/coforge.gz" > "$temporary_directory/coforge") || {
  echo "cli-install.sh: compressed CLI could not be decompressed safely" >&2
  exit 1
}
[ "$(sha256_of "$temporary_directory/coforge")" = "$manifest_sha256" ] || {
  echo "cli-install.sh: downloaded CLI failed its checksum check" >&2
  exit 1
}
mkdir -p "$bin_directory"
staged_path=$(mktemp "$bin_directory/.coforge.XXXXXX")
cp "$temporary_directory/coforge" "$staged_path"
chmod 755 "$staged_path"
mv -f "$staged_path" "$bin_directory/coforge"
staged_path=
echo "coforge $version installed to $bin_directory/coforge" >&2
case ":${PATH:-}:" in
  *":$bin_directory:"*) ;;
  *) echo "Add it to your PATH: export PATH=\"$bin_directory:\$PATH\"" >&2 ;;
esac
