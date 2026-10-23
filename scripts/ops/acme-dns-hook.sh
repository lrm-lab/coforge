#!/usr/bin/env bash
# acme.sh DNS hook "dns_cdncert": sourced by acme.sh (copied to <acme home>/dnsapi/dns_cdncert.sh by
# renew-cdn-certificates.ts). It only forwards to the Bun tool, which signs the Alibaba Cloud DNS
# calls with the workflow's STS credential; acme.sh never sees a credential.
# CDN_CERT_TOOL names renew-cdn-certificates.ts.

dns_cdncert_add() {
  bun "$CDN_CERT_TOOL" dns add "$1" "$2" || return 1
}

dns_cdncert_rm() {
  bun "$CDN_CERT_TOOL" dns rm "$1" "$2" || return 1
}
