#!/usr/bin/env bash
# Checks SQL migrations for backward-incompatible / destructive DDL.
#
# Rules under Blue-Green Zero-Downtime Deployment (Expand-Contract):
# Allowed (Backward-Compatible):
#   - ADD COLUMN (nullable or with DEFAULT)
#   - CREATE TABLE
#   - CREATE INDEX / CREATE UNIQUE INDEX
#   - ALTER COLUMN ... DROP NOT NULL
#
# Blocked (Destructive / Breaks running code):
#   - RENAME COLUMN / RENAME TABLE
#   - DROP COLUMN / DROP TABLE
#   - ALTER COLUMN ... TYPE
#   - ALTER COLUMN ... SET NOT NULL (without DEFAULT)
#   - DROP CONSTRAINT ... PRIMARY KEY / altering primary key
#
# Bypass:
#   Set ALLOW_BREAKING_MIGRATION=true or pass --allow-breaking.

set -euo pipefail

allow_breaking="${ALLOW_BREAKING_MIGRATION:-false}"
files=()

while [ "$#" -gt 0 ]; do
	case "$1" in
	--allow-breaking)
		allow_breaking=true
		shift
		;;
	*)
		files+=("$1")
		shift
		;;
	esac
done

if [ "${#files[@]}" -eq 0 ]; then
	printf 'Usage: %s [--allow-breaking] <migration.sql | migrations_dir ...>\n' "$0" >&2
	exit 2
fi

# Expand directories to migration.sql files
target_files=()
for item in "${files[@]}"; do
	if [ -d "$item" ]; then
		while IFS= read -r f; do
			target_files+=("$f")
		done < <(find "$item" -name "migration.sql" | sort)
	elif [ -f "$item" ]; then
		target_files+=("$item")
	else
		printf 'check-migration-safety: %s not found\n' "$item" >&2
		exit 1
	fi
done

violations=0

check_file() {
	local file="$1"
	local line_num=0
	local in_multiline_comment=0

	while IFS= read -r raw_line || [ -n "$raw_line" ]; do
		line_num=$((line_num + 1))

		# Strip leading/trailing whitespace
		line="$(printf '%s' "$raw_line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

		# Skip empty lines or pure single-line comments
		if [ -z "$line" ] || [[ "$line" =~ ^-- ]]; then
			continue
		fi

		# Case-insensitive checks
		upper="$(printf '%s' "$line" | tr '[:lower:]' '[:upper:]')"

		# 1. RENAME COLUMN or RENAME TABLE
		if [[ "$upper" =~ RENAME[[:space:]]+(COLUMN|TABLE) ]] || [[ "$upper" =~ ALTER[[:space:]]+TABLE[[:space:]]+[^[:space:]]+[[:space:]]+RENAME ]]; then
			printf '%s:%d: [DESTRUCTIVE] Rename detected: "%s"\n' "$file" "$line_num" "$raw_line" >&2
			violations=$((violations + 1))
			continue
		fi

		# 2. DROP COLUMN or DROP TABLE
		if [[ "$upper" =~ DROP[[:space:]]+(COLUMN|TABLE) ]]; then
			printf '%s:%d: [DESTRUCTIVE] Drop table/column detected: "%s"\n' "$file" "$line_num" "$raw_line" >&2
			violations=$((violations + 1))
			continue
		fi

		# 3. ALTER COLUMN ... TYPE
		if [[ "$upper" =~ ALTER[[:space:]]+COLUMN[[:space:]]+[^[:space:]]+[[:space:]]+TYPE ]] || [[ "$upper" =~ ALTER[[:space:]]+COLUMN[[:space:]]+[^[:space:]]+[[:space:]]+SET[[:space:]]+DATA[[:space:]]+TYPE ]]; then
			printf '%s:%d: [DESTRUCTIVE] Column type alteration detected: "%s"\n' "$file" "$line_num" "$raw_line" >&2
			violations=$((violations + 1))
			continue
		fi

		# 4. ALTER COLUMN ... SET NOT NULL
		if [[ "$upper" =~ ALTER[[:space:]]+COLUMN[[:space:]]+[^[:space:]]+[[:space:]]+SET[[:space:]]+NOT[[:space:]]+NULL ]] || [[ "$upper" =~ SET[[:space:]]+NOT[[:space:]]+NULL ]]; then
			# Safe only if preceded by DEFAULT on the same statement or table
			printf '%s:%d: [DESTRUCTIVE] SET NOT NULL without backward-compatible default detected: "%s"\n' "$file" "$line_num" "$raw_line" >&2
			violations=$((violations + 1))
			continue
		fi

		# 5. Primary Key manipulation
		if [[ "$upper" =~ DROP[[:space:]]+CONSTRAINT[[:space:]]+[^[:space:]]+[[:space:]]+PRIMARY[[:space:]]+KEY ]] || [[ "$upper" =~ DROP[[:space:]]+CONSTRAINT[[:space:]]+.*_PKEY ]] || [[ "$upper" =~ ADD[[:space:]]+CONSTRAINT[[:space:]]+.*PRIMARY[[:space:]]+KEY ]]; then
			printf '%s:%d: [DESTRUCTIVE] Primary key / constraint destruction detected: "%s"\n' "$file" "$line_num" "$raw_line" >&2
			violations=$((violations + 1))
			continue
		fi

	done < "$file"
}

for tf in "${target_files[@]}"; do
	check_file "$tf"
done

if [ "$violations" -gt 0 ]; then
	if [ "$allow_breaking" = "true" ]; then
		printf 'check-migration-safety: %d destructive migration violation(s) found, bypassed via ALLOW_BREAKING_MIGRATION=true\n' "$violations" >&2
		exit 0
	else
		printf 'check-migration-safety: FAILED with %d destructive migration violation(s). Rephrase as expand-contract (separate releases) or set ALLOW_BREAKING_MIGRATION=true if intentional.\n' "$violations" >&2
		exit 1
	fi
fi

printf 'check-migration-safety: PASSED (checked %d files)\n' "${#target_files[@]}"
exit 0
