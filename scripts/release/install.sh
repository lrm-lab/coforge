#!/bin/sh
set -eu

default_feed_url="https://releases.coforge.cn"
feed_url=${COFORGE_RELEASE_FEED_URL:-$default_feed_url}
feed_url=${feed_url%/}

command=install
case "${1:-}" in
  install|upgrade|repair|status|recover)
    command=$1
    shift
    ;;
esac
version=latest
version_arg=0
prepare_directory=
prepare_arg=0
target=
target_arg=0
resolve_only=0
quiet_header=0
prepare_phase=all
workspace=
json=0
request_id=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prepare-directory|--target|--prepare-phase|--workspace)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "install.sh: $1 requires a value" >&2; exit 2; }
      case "$1" in
        --prepare-directory) prepare_directory=$2; prepare_arg=1 ;;
        --target) target=$2; target_arg=1 ;;
        --prepare-phase) prepare_phase=$2; prepare_arg=1 ;;
        --workspace) workspace=$2 ;;
      esac
      shift 2
      ;;
    --resolve-only) resolve_only=1; shift ;;
    --quiet-header) quiet_header=1; prepare_arg=1; shift ;;
    --version)
      [ "$#" -ge 2 ] || { echo "install.sh: --version requires a value" >&2; exit 2; }
      version=$2
      version_arg=1
      shift 2
      ;;
    --request-id)
      [ "$#" -ge 2 ] || { echo "install.sh: --request-id requires a value" >&2; exit 2; }
      request_id=$2
      shift 2
      ;;
    --json)
      json=1
      shift
      ;;
    -h|--help)
      echo "Usage: install.sh [install|upgrade|repair|status|recover] [--version latest|<version>] [--workspace <slug>]"
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $1" >&2
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
  echo "install.sh: version must be latest or a valid version string" >&2
  exit 2
fi

case "$command" in
  install)
    [ "$json" -eq 0 ] || { echo "install.sh: --json is only valid with status" >&2; exit 2; }
    [ -z "$request_id" ] || { echo "install.sh: --request-id is only valid with upgrade" >&2; exit 2; }
    ;;
  upgrade)
    [ -n "$request_id" ] || { echo "install.sh: upgrade requires --request-id" >&2; exit 2; }
    [ "$json" -eq 0 ] || { echo "install.sh: --json is only valid with status" >&2; exit 2; }
    [ -z "$workspace" ] || { echo "install.sh: --workspace is only valid with install" >&2; exit 2; }
    ;;
  repair)
    [ "$version_arg" -eq 0 ] || { echo "install.sh: repair does not select a Computer version; --version is not supported" >&2; exit 2; }
    [ -z "$request_id" ] || { echo "install.sh: repair does not accept --request-id" >&2; exit 2; }
    [ "$json" -eq 0 ] || { echo "install.sh: --json is only valid with status" >&2; exit 2; }
    [ -z "$workspace" ] || { echo "install.sh: --workspace is only valid with install" >&2; exit 2; }
    ;;
  status)
    [ "$version_arg" -eq 0 ] || { echo "install.sh: status does not select a Computer version; --version is not supported" >&2; exit 2; }
    [ -z "$request_id" ] || { echo "install.sh: status does not accept --request-id" >&2; exit 2; }
    [ -z "$workspace" ] || { echo "install.sh: --workspace is only valid with install" >&2; exit 2; }
    ;;
  recover)
    [ "$version_arg" -eq 0 ] || { echo "install.sh: recover does not select a Computer version; --version is not supported" >&2; exit 2; }
    [ -z "$request_id" ] || { echo "install.sh: recover does not accept --request-id" >&2; exit 2; }
    [ "$json" -eq 0 ] || { echo "install.sh: --json is only valid with status" >&2; exit 2; }
    [ -z "$workspace" ] || { echo "install.sh: --workspace is only valid with install" >&2; exit 2; }
    ;;
esac

if [ "$command" != install ] && {
  [ "$prepare_arg" -eq 1 ] || [ "$target_arg" -eq 1 ] || [ "$resolve_only" -eq 1 ];
}; then
  echo "install.sh: preparation options are only valid with install" >&2
  exit 2
fi

test_mode=${COFORGE_INSTALLER_TEST_MODE:-}
case "$feed_url" in
  https://*) curl_proto='=https' ;;
  http://*)
    [ "$test_mode" = "1" ] || {
      echo "install.sh: COFORGE_RELEASE_FEED_URL must use HTTPS" >&2
      exit 2
    }
    curl_proto='=http,https'
    ;;
  *)
    echo "install.sh: COFORGE_RELEASE_FEED_URL must use HTTPS" >&2
    exit 2
    ;;
esac

if [ -z "$prepare_directory" ] && [ "$resolve_only" -eq 0 ]; then
command -v gzip >/dev/null 2>&1 || {
  echo "install.sh: gzip is required to install CoForge Computer" >&2
  exit 1
}
fi

if [ -z "$target" ]; then
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Darwin-arm64) target=darwin-arm64 ;;
  *) echo "install.sh: unsupported platform" >&2; exit 1 ;;
esac
fi
case "$target" in
  linux-x64) platform='Linux x64' ;;
  linux-arm64) platform='Linux ARM64' ;;
  darwin-x64) platform='macOS (Intel)' ;;
  darwin-arm64) platform='macOS (Apple Silicon)' ;;
  windows-x64) platform='Windows x64' ;;
  windows-arm64) platform='Windows ARM64' ;;
  *) echo "install.sh: unsupported release target: $target" >&2; exit 2 ;;
esac
case "$prepare_phase" in
  all) ;;
  manifest|artifact|installer) [ -n "$prepare_directory" ] || { echo "install.sh: preparation phase requires a directory" >&2; exit 2; } ;;
  *) echo "install.sh: invalid preparation phase" >&2; exit 2 ;;
esac

if [ -n "$prepare_directory" ]; then
  [ -d "$prepare_directory" ] || { echo "install.sh: preparation directory must already exist" >&2; exit 2; }
  temporary_directory=$prepare_directory
else
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/coforge-installer.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
fi

is_interactive=0
if [ -t 2 ]; then
  is_interactive=1
else
  is_interactive=0
fi

if [ "$is_interactive" -eq 1 ] && [ "${COFORGE_INSTALLER_NO_COLOR:-}" != "1" ] && [ -z "${NO_COLOR:-}" ]; then
  bold='\033[1m'
  accent='\033[36m'
  success='\033[32m'
  reset='\033[0m'
else
  bold=''; accent=''; success=''; reset=''
fi

step() {
  printf '%b\n' "${accent}==>${reset} ${bold}$1${reset}" >&2
}

done_step() {
  printf '%b\n' "${success}   ✓${reset} $1" >&2
}

# Exit status of --resolve-only and --prepare-directory when the feed could not be reached (curl
# transport failure) or answered with a 4xx/5xx status; the Computer maps it to
# UPDATE_DOWNLOAD_FAILED and retries. Every other failure, including --max-filesize exceeded
# (curl 63), keeps exit 1. The bootstrap path (`curl | sh`) keeps exit 1 throughout. 0, 1 and 2
# are this script's own; 75 is sysexits' EX_TEMPFAIL.
download_failed_status=75

# The status a failed download exits with: the dedicated one for the Computer's own modes when
# the cause is transport or HTTP status (curl 63 is the size cap, a content judgement).
download_failure() {
  if [ "$1" -ne 63 ] && { [ -n "$prepare_directory" ] || [ "$resolve_only" -eq 1 ]; }; then
    return "$download_failed_status"
  fi
  return 1
}

fetch() {
  # Metadata must not follow redirects. --fail alone accepts 3xx responses.
  curl_status=0
  status=$(curl --fail --silent --show-error --proto "$curl_proto" --tlsv1.2 --write-out '%{http_code}' "$@") || curl_status=$?
  [ "$curl_status" -eq 0 ] || { download_failure "$curl_status" || return $?; }
  case "$status" in
    2??) ;;
    # A redirect is the feed answering against its contract, not a failure to reach it.
    3??) echo "install.sh: download returned HTTP $status (redirects are not followed)" >&2; return 1 ;;
    *) echo "install.sh: download returned HTTP $status (redirects are not followed)" >&2; download_failure 0 || return $? ;;
  esac
}

fetch_binary() {
  progress=--silent
  if [ "$is_interactive" -eq 1 ] && [ "${COFORGE_INSTALLER_PROGRESS:-}" != "0" ]; then
    progress=--progress-bar
  fi
  # Preserve bootstrap's HTTPS-only redirects; updater preparation refuses every redirect.
  redirects=--location
  [ -z "$prepare_directory" ] || redirects=
  curl_status=0
  status=$(curl --fail "$progress" --show-error $redirects --proto "$curl_proto" --proto-redir "$curl_proto" --tlsv1.2 --write-out '%{http_code}' "$@") || curl_status=$?
  [ "$curl_status" -eq 0 ] || { download_failure "$curl_status" || return $?; }
  case "$status" in
    2??) ;;
    3??) echo "install.sh: download returned HTTP $status" >&2; return 1 ;;
    *) echo "install.sh: download returned HTTP $status" >&2; download_failure 0 || return $? ;;
  esac
}

max_pointer_bytes=4096
max_manifest_bytes=1048576
max_binary_bytes=536870912
max_wasm_bytes=16777216

[ "$quiet_header" -eq 1 ] || step "Detected platform: $platform"
if [ -n "$prepare_directory" ] || [ "$resolve_only" -eq 1 ]; then
  if [ "$version" = "latest" ]; then
    [ "$quiet_header" -eq 1 ] || step "Finding the latest CoForge Computer version"
    fetch --max-filesize "$max_pointer_bytes" --output "$temporary_directory/latest" "$feed_url/latest"
    latest_pointer=$(tr -d '[:space:]' < "$temporary_directory/latest")
    rm "$temporary_directory/latest"
    if [ "$latest_pointer" = latest ] || ! is_valid_version "$latest_pointer"; then
      echo "install.sh: the latest pointer did not return a valid version" >&2
      exit 1
    fi
    version=$latest_pointer
  fi

  [ "$quiet_header" -eq 1 ] || step "Resolved version: $version"
  if [ "$resolve_only" -eq 1 ]; then
    printf '%s\n' "$version"
    exit 0
  fi

  # The `installer` phase fetches one object of the installer feed (`<feed>/installer/...`, so the
  # caller passes that as the feed URL): this target's coforge-installer gzip and nothing else. Its
  # name is derived from the target here, never taken from a caller, and the caller verifies size
  # and checksum against the installer manifest it fetched with the `manifest` phase.
  if [ "$prepare_phase" = installer ]; then
    case "$target" in
      windows-*) installer_gzip=coforge-installer.exe.gz ;;
      *) installer_gzip=coforge-installer.gz ;;
    esac
    step "Downloading CoForge installer"
    fetch_binary --max-filesize "$max_binary_bytes" --output "$temporary_directory/$installer_gzip" "$feed_url/$version/$target/$installer_gzip"
    exit 0
  fi

  if [ "$prepare_phase" != artifact ]; then
    fetch --max-filesize "$max_manifest_bytes" --output "$temporary_directory/manifest.json" "$feed_url/$version/manifest.json"
  fi
  [ "$prepare_phase" != manifest ] || exit 0
  compressed_path="$temporary_directory/coforge-computer.gz"
  step "Downloading CoForge Computer"
  fetch_binary --max-filesize "$max_binary_bytes" --output "$compressed_path" "$feed_url/$version/$target/coforge-computer.gz"
  # Pi's image library is part of the Computer download step and gets no progress line of its own;
  # only a failed fetch mentions it.
  fetch --max-filesize "$max_wasm_bytes" --output "$temporary_directory/photon_rs_bg.wasm" "$feed_url/$version/photon_rs_bg.wasm"
  printf '%s\n' "$version" > "$temporary_directory/version"
  if [ -n "$prepare_directory" ]; then
    exit 0
  fi

fi

step "Finding the CoForge installer"
installer_pointer_path="$temporary_directory/installer-latest"
fetch --max-filesize "$max_pointer_bytes" --output "$installer_pointer_path" "$feed_url/installer/latest"
installer_version=$(tr -d '[:space:]' < "$installer_pointer_path")
rm "$installer_pointer_path"
if [ "$installer_version" = latest ] || ! is_valid_version "$installer_version"; then
  echo "install.sh: the installer pointer did not return a valid version" >&2
  exit 1
fi

case "$target" in
  windows-*) installer_gzip=coforge-installer.exe.gz; installer_binary=coforge-installer.exe ;;
  *) installer_gzip=coforge-installer.gz; installer_binary=coforge-installer ;;
esac
installer_url="$feed_url/installer/$installer_version/$target"

step "Downloading CoForge installer"
fetch_binary --max-filesize "$max_binary_bytes" --output "$temporary_directory/$installer_gzip" "$installer_url/$installer_gzip"

sidecar_path="$temporary_directory/coforge-installer.sha256"
fetch --max-filesize "$max_pointer_bytes" --output "$sidecar_path" "$installer_url/coforge-installer.sha256"
expected_sha256=$(tr -d '[:space:]' < "$sidecar_path")
case "$expected_sha256" in
  *[!a-f0-9]*) expected_sha256= ;;
esac
if [ -z "$expected_sha256" ] || [ "${#expected_sha256}" -ne 64 ]; then
  echo "install.sh: sidecar checksum for $target is missing or malformed" >&2
  exit 1
fi

installer_path="$temporary_directory/$installer_binary"
(ulimit -f 1048576; gzip -dc "$temporary_directory/$installer_gzip" > "$installer_path") || {
  echo "install.sh: compressed installer could not be decompressed safely" >&2
  exit 1
}
[ "$(wc -c < "$installer_path" | tr -d '[:space:]')" -le "$max_binary_bytes" ] || {
  echo "install.sh: decompressed installer exceeds the size limit" >&2
  exit 1
}

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$installer_path" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256=$(shasum -a 256 "$installer_path" | awk '{print $1}')
else
  actual_sha256=$(openssl dgst -sha256 "$installer_path" | awk '{print $NF}')
fi
[ "$actual_sha256" = "$expected_sha256" ] || {
  echo "install.sh: downloaded installer failed its checksum check" >&2
  exit 1
}

chmod 700 "$installer_path"
run_installer() {
  case "$command" in
    install) "$installer_path" install --version "$version" ;;
    upgrade) "$installer_path" upgrade --request-id "$request_id" --version "$version" ;;
    repair) "$installer_path" repair ;;
    status)
      if [ "$json" -eq 1 ]; then "$installer_path" status --json; else "$installer_path" status; fi
      ;;
    recover) "$installer_path" recover ;;
  esac
}

installer_status=0
run_installer || installer_status=$?
[ "$installer_status" -eq 3 ] && [ "$command" != status ] && [ "$command" != recover ] && {
  echo "install.sh: retrying installer once after exit 3" >&2
  installer_status=0
  run_installer || installer_status=$?
}
[ "$installer_status" -eq 0 ] || exit "$installer_status"

[ "$command" = install ] || exit 0

computer_label="CoForge Computer"
[ "$version" = latest ] || computer_label="CoForge Computer $version"

bin_directory=${XDG_BIN_HOME:-}
case "$bin_directory" in
  /*) ;;
  *) bin_directory="$HOME/.local/bin" ;;
esac

# This script is served by the web app and the binary comes from the release feed, so the two
# reach a user on independent cadences: a deploy carrying this version of the script can download
# a published version that still installs its shim somewhere else. Every message below - most of
# all the "already on PATH, just run it" path - would then name a command that does not exist, so
# confirm the shim really landed where this script believes it did before claiming anything.
if [ ! -x "$bin_directory/coforge-computer" ]; then
  echo "install.sh: $computer_label was installed, but no shim appeared at" >&2
  echo "install.sh: $bin_directory/coforge-computer - that version predates this installer." >&2
  echo "install.sh: re-run this installer once a newer CoForge Computer version is published." >&2
  exit 1
fi

# Expand HOME and PATH when the user's shell reads its configuration, not in this installer. The
# literal below is only correct for the default directory; an XDG_BIN_HOME install writes the
# already-resolved path instead, since that variable need not be set in a later shell.
if [ "$bin_directory" = "$HOME/.local/bin" ]; then
  # shellcheck disable=SC2016
  posix_path_line='export PATH="$HOME/.local/bin:$PATH"'
  # shellcheck disable=SC2016
  fish_path_line='fish_add_path "$HOME/.local/bin"'
else
  posix_path_line="export PATH=\"$bin_directory:\$PATH\""
  fish_path_line="fish_add_path \"$bin_directory\""
fi

# `--workspace` makes the web's connect dialog one pasted command (`curl ... | sh -s -- --workspace
# <slug>`). The PATH edit below only reaches shells started later, so setup runs through the shim's
# own path. Under `curl ... | sh` this script's stdin is the script itself, so setup reads the
# terminal instead; with no terminal it reads nothing rather than the rest of this script.
run_setup() {
  [ -n "$workspace" ] || return 0
  step "Connecting this Computer to Workspace $workspace"
  setup_input=/dev/null
  if (: </dev/tty) 2>/dev/null; then setup_input=/dev/tty; fi
  # set -e ends the script with setup's own status when it fails.
  "$bin_directory/coforge-computer" setup --workspace "$workspace" <"$setup_input"
  exit 0
}

# Installing into the XDG user binary directory is what makes this "just work": it is already on
# PATH for most users, so the command is usable in this very shell and there is nothing to
# configure and nothing to tell the user to run. Shell configuration is edited only in the
# fallback below, when the directory really is absent from PATH.
case ":${PATH:-}:" in
  *":$bin_directory:"*)
    step "$bin_directory is already on PATH"
    done_step "$computer_label installed and ready to use"
    run_setup
    printf '%b\n' "Next: ${accent}coforge-computer setup --workspace <slug>${reset}" >&2
    exit 0
    ;;
esac

append_path_line() {
  configuration_path=$1
  configuration_line=$2
  configuration_directory=${configuration_path%/*}

  mkdir -p "$configuration_directory" || return 1
  if [ -f "$configuration_path" ] && grep -Fqx "$configuration_line" "$configuration_path"; then
    return 0
  fi
  printf '\n%s\n' "$configuration_line" >> "$configuration_path"
}

case "${SHELL:-}" in
  */fish)
    fish_configuration_root=${XDG_CONFIG_HOME:-$HOME/.config}
    shell_configuration="$fish_configuration_root/fish/conf.d/coforge.fish"
    shell_path_line=$fish_path_line
    session_command="fish_add_path \"$bin_directory\""
    shell_name=fish
    ;;
  */zsh)
    shell_configuration="${ZDOTDIR:-$HOME}/.zshrc"
    shell_path_line=$posix_path_line
    session_command="export PATH=\"$bin_directory:\$PATH\""
    shell_name=zsh
    ;;
  */bash)
    shell_configuration="$HOME/.bashrc"
    shell_path_line=$posix_path_line
    session_command="export PATH=\"$bin_directory:\$PATH\""
    shell_name=bash
    ;;
  *) shell_configuration= ;;
esac

if [ -n "$shell_configuration" ]; then
  if ! append_path_line "$shell_configuration" "$shell_path_line"; then
    echo "install.sh: $computer_label was installed, but PATH could not be saved to $shell_configuration" >&2
    echo "install.sh: add this line manually: $shell_path_line" >&2
    exit 1
  fi
  if [ "$shell_name" = bash ]; then
    # Login Bash reads the first existing profile, not .bashrc (notably on macOS).
    login_configuration="$HOME/.bash_profile"
    for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      if [ -f "$candidate" ]; then
        login_configuration=$candidate
        break
      fi
    done
    if ! append_path_line "$login_configuration" "$shell_path_line"; then
      echo "install.sh: $computer_label was installed, but PATH could not be saved to $login_configuration" >&2
      exit 1
    fi
  fi
  done_step "Added $bin_directory to your $shell_name PATH in $shell_configuration"
else
  echo "install.sh: warning: SHELL is not bash, zsh, or fish, so PATH was left unchanged" >&2
  session_command="export PATH=\"$bin_directory:\$PATH\""
fi

done_step "$computer_label installed"
printf '%b\n' "Current terminal: ${accent}$session_command${reset}" >&2
run_setup
printf '%s\n' "Next: \"$bin_directory/coforge-computer\" setup --workspace <slug>" >&2
