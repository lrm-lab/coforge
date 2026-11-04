import type { HelpEntry } from "./entry";

/** The `app` commands' help, spread into the command-help registry in `index.ts`. */
export const appHelp: Readonly<Record<string, HelpEntry>> = {
  app: {
    syntax: "coforge app list|config|marketplace|token|invoke ...",
    example: "coforge app list",
  },
  "app config": {
    syntax:
      "coforge app config --app <app-id> [--set <key>=<value>]... [--unset <key>]... [--json]",
  },
  "app list": {
    syntax: "coforge app list [--all] [--json]",
  },
  "app marketplace": {
    syntax: "coforge app marketplace [<query>] [--limit <1-50>] [--json]",
  },
  "app update": {
    syntax: "coforge app update --client <key> [--name <n>] [--description <t>] [--when-to-use <t>] [--category <c>] [--homepage-url <u> | --clear-homepage-url] [--redirect-url <u>]... [--agent-manifest-url <u> | --clear-agent-manifest-url] [--scope <scope>]... [--json]",
  },
  "app logo": {
    syntax: "coforge app logo --client <key> --file <path> [--json]",
  },
  "app clear-logo": {
    syntax: "coforge app clear-logo --client <key> [--json]",
  },
  "app delete": {
    syntax: "coforge app delete --client <key> [--json]",
  },
  "app transfer-owner": {
    syntax: "coforge app transfer-owner --client <key> --to-agent <name> [--json]",
  },
  "app share-link": {
    syntax: "coforge app share-link --client <key> [--expires-days <1-365>] [--json]",
  },
  "app share-link-status": {
    syntax: "coforge app share-link-status --client <key> [--json]",
  },
  "app revoke-share-link": {
    syntax: "coforge app revoke-share-link --client <key> [--json]",
  },
  "app request-publish": {
    syntax: "coforge app request-publish --client <key> [--json]",
  },
  "app request-unpublish": {
    syntax: "coforge app request-unpublish --client <key> [--json]",
  },
  "app token": {
    syntax:
      "coforge app token --app <key> [--target <target>] [--timeout <seconds>] --exec <program> [-- <args>...]",
  },
  "app invoke": {
    syntax: "coforge app invoke <app> <action> [--input <json>] [--json]",
  },
  "app prepare": {
    syntax: "coforge app prepare --target <target>",
  },
  "app status": {
    syntax: "coforge app status --app <key> [--json]",
  },
  "app rotate-secret": {
    syntax: "coforge app rotate-secret --app <key> [--json]",
  },
};
