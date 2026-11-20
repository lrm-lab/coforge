#!/usr/bin/env bash
# Release snapshot for remote-deploy.sh: records and restores the last healthy release's files. It defines functions and runs nothing; remote-deploy.sh sources it.

# Records the just-verified-healthy Compose file, Caddyfile, and Centrifugo
# configuration so a later failed candidate can restore this exact release,
# not only its image. Writes to a temporary directory first and swaps it into
# place, so a snapshot in progress never leaves a partial one on disk.
snapshot_release() {
	local source_dir tmp_dir file source dest profile
	source_dir="$(dirname "$compose_file")"
	tmp_dir="$(mktemp -d "${release_snapshot_dir}.XXXXXX")"
	chmod 700 "$tmp_dir"
	for file in "${release_snapshot_files[@]}"; do
		source="$source_dir/$file"
		[ -f "$source" ] || continue
		dest="$tmp_dir/$file"
		mkdir -p "$(dirname "$dest")"
		cp -pf "$source" "$dest"
	done
	if [ -n "${checker_compose_file:-}" ] && [ -f "$checker_compose_file" ]; then
		cp -pf "$checker_compose_file" "$tmp_dir/artifact-checker.compose.yml"
		profile="$(dirname "$checker_compose_file")/artifact-checker-seccomp.json"
		if [ -f "$profile" ]; then
			cp -pf "$profile" "$tmp_dir/artifact-checker-seccomp.json"
		fi
	fi
	rm -rf "${release_snapshot_dir}.previous"
	if [ -d "$release_snapshot_dir" ]; then
		mv "$release_snapshot_dir" "${release_snapshot_dir}.previous"
	fi
	mv "$tmp_dir" "$release_snapshot_dir"
	rm -rf "${release_snapshot_dir}.previous"
	chmod 700 "$release_snapshot_dir"
}

# Restores the last healthy release's Compose file, Caddyfile, and Centrifugo
# configuration into their live paths ahead of a rollback. Only files that
# were actually snapshotted are restored.
restore_release_snapshot() {
	local source_dir file source dest
	source_dir="$(dirname "$compose_file")"
	for file in "${release_snapshot_files[@]}"; do
		source="$release_snapshot_dir/$file"
		[ -f "$source" ] || continue
		dest="$source_dir/$file"
		mkdir -p "$(dirname "$dest")"
		cp -pf "$source" "$dest"
	done
	if [ -n "${checker_compose_file:-}" ] && [ -f "$release_snapshot_dir/artifact-checker.compose.yml" ]; then
		cp -pf "$release_snapshot_dir/artifact-checker.compose.yml" "$checker_compose_file"
		if [ -f "$release_snapshot_dir/artifact-checker-seccomp.json" ]; then
			cp -pf "$release_snapshot_dir/artifact-checker-seccomp.json" "$(dirname "$checker_compose_file")/artifact-checker-seccomp.json"
		fi
	fi
}
