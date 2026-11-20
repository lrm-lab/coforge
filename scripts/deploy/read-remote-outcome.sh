#!/usr/bin/env bash
set -e

expected_keys='health_result|outcome|previous_web_image|rollback_target'
seen="$(cut -d= -f1 remote-report.env | grep -v '^$' | grep -v '^warning$' | sort | uniq | paste -sd'|')"
if [ "$seen" != "$expected_keys" ]; then
  echo "remote report keys mismatch: $seen" >&2
  exit 1
fi
{
  echo "outcome=$(sed -n 's/^outcome=//p' remote-report.env)"
  echo "previous_web_image=$(sed -n 's/^previous_web_image=//p' remote-report.env)"
  echo "health_result=$(sed -n 's/^health_result=//p' remote-report.env)"
  echo "rollback_target=$(sed -n 's/^rollback_target=//p' remote-report.env)"
} >> "$GITHUB_OUTPUT"
warning="$(sed -n 's/^warning=//p' remote-report.env)"
if [ -n "$warning" ]; then echo "::warning::$warning"; fi
