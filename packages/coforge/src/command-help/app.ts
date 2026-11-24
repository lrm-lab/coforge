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
    syntax:
      "coforge app update --client <key> [--name <n>] [--description <t>] [--when-to-use <t>] [--category <c>] [--homepage-url <u> | --clear-homepage-url] [--redirect-url <u>]... [--agent-manifest-url <u> | --clear-agent-manifest-url] [--scope <scope>]... [--json]",
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
    syntax: [
      "coforge app invoke <app-key> --list-actions [--action <name>] [--json]",
      "coforge app invoke <app-key> (<action> | --action <name>)",
      "  [(--param <key=value>)... | --data-json <object> | --data-file <path|->]",
      "  [--preflight] [--idempotency-key <key>] [--target <target>] [--timeout <seconds>] [--json]",
    ].join("\n  "),
    example: [
      "coforge app invoke example-app --list-actions",
      "coforge app invoke example-app --list-actions --action lookup",
      "coforge app invoke example-app lookup --param query=hello",
      `coforge app invoke example-app lookup --data-json '{"query":"hello world"}'`,
      "coforge app invoke example-app lookup --data-file ./example.json",
    ].join("\n         "),
  },
  "app prepare": {
    syntax: [
      "coforge app prepare register --target <target> --name <name>",
      "coforge app prepare recover-owner --client <key> --to-agent <name> --target <target>",
    ].join("\n  "),
    example: [
      "coforge app prepare register --target '#example' --name 'Example App'",
      "coforge app prepare recover-owner --client example-app --to-agent example-agent --target '#example'",
    ].join("\n         "),
  },
  "app status": {
    syntax: "coforge app status (--card <message-id> | --client <key>) [--json]",
    example: [
      "coforge app status --card 11111111-1111-4111-8111-111111111111",
      "coforge app status --client example-app --json",
    ].join("\n         "),
  },
  "app rotate-secret": {
    syntax: "coforge app rotate-secret --client <key> --output <new path> [--json]",
    example: "coforge app rotate-secret --client example-app --output ./example-secret.txt",
  },
};
