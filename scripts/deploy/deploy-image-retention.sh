#!/usr/bin/env bash
# Deploy image retention for remote-deploy.sh: every deploy pulls one immutable
# digest and nothing removed the previous ones, so the hosts accumulated
# hundreds of web images (staging reached 456G used on /data before the
# 2026-11-16 cleanup). After a verified outcome this keeps the newest few web
# images by creation time plus every image a container references, and removes
# the rest. It defines functions and runs nothing; remote-deploy.sh sources it.
#
# The functions read deploy_image_retention and deploy_warning from the
# sourcing script's scope and call docker; pruning never fails a deployment.

deploy_image_retention=5

# Prints "ID|repository|createdAt" for local images of the deployed web app.
# --no-trunc keeps the full sha256 ID so it compares exactly against the
# canonical {{.Id}} that container_image_ids collects. Digest-only pulls show
# tag <none> but keep the repository name under --digests, and the pattern
# matches any org prefix so pre-rename lrm-teams copies are covered as well.
deploy_repo_images() {
	local pattern="$1"
	docker images --no-trunc --digests --format '{{.ID}}|{{.Repository}}|{{.CreatedAt}}' |
		awk -F'|' -v pat="$pattern" '$2 ~ pat'
}

deploy_web_images() {
	deploy_repo_images '(^|\/)coforge\/coforge-web$'
}

deploy_checker_images() {
	deploy_repo_images '(^|\/)coforge\/coforge-artifact-checker$'
}

# Prints the canonical image ID of every container, running or stopped, so a
# referenced image is never a removal candidate even when it is old. Fails
# when the container list itself cannot be read: without it there is no way to
# know which images are protected, so the caller must not remove anything.
container_image_ids() {
	local containers container ref id
	containers="$(docker ps -aq 2>/dev/null)" || return 1
	[ -n "$containers" ] || return 0
	printf '%s\n' "$containers" | while IFS= read -r container; do
		ref="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" || continue
		[ -n "$ref" ] || continue
		id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null)" || id="$ref"
		printf '%s\n' "$id"
	done | sort -u
}

# Prints the IDs of in-scope web and checker images to remove: everything older than the
# newest $deploy_image_retention unique image IDs per repository, minus container references.
deploy_images_to_remove() {
	local protected
	protected="$(container_image_ids)" || return 1
	{
		deploy_web_images |
			sort -t'|' -k3,3 -r |
			awk -F'|' '!seen[$1]++' |
			tail -n "+$((deploy_image_retention + 1))" |
			cut -d'|' -f1
		deploy_checker_images |
			sort -t'|' -k3,3 -r |
			awk -F'|' '!seen[$1]++' |
			tail -n "+$((deploy_image_retention + 1))" |
			cut -d'|' -f1
	} | sort -u | grep -vxF -f <(printf '%s\n' "$protected") || true
}

# Removes stale web images after a verified outcome. Every docker call is
# best-effort: failures warn on stderr and surface through deploy_warning, and
# the function always returns 0 so it can never fail the deployment.
# `docker rmi -f` is required: without it an ID still tagged under several
# repositories (e.g. the same image under the old lrm-teams and current
# lrm-lab names) is refused as "referenced in multiple repositories" and
# would linger forever. Images referenced by a container are already
# excluded, so the force flag cannot remove anything in use.
prune_deploy_images() {
	local id ids count=0 failures=0
	if ! ids="$(deploy_images_to_remove 2>/dev/null)"; then
		printf 'warning: web image retention skipped: could not enumerate containers\n' >&2
		deploy_warning="${deploy_warning:+$deploy_warning; }web image retention skipped"
		return 0
	fi
	[ -n "$ids" ] || return 0
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		if docker rmi -f "$id" >/dev/null 2>&1; then
			count=$((count + 1))
		else
			failures=$((failures + 1))
			printf 'warning: could not remove web image %s\n' "$id" >&2
		fi
	done <<<"$ids"
	printf 'web image retention: removed %d stale image(s), kept newest %d plus container-referenced images\n' \
		"$count" "$deploy_image_retention" >&2
	if [ "$failures" -gt 0 ]; then
		deploy_warning="${deploy_warning:+$deploy_warning; }web image retention left $failures image(s) behind"
	fi
	return 0
}
