# Release notes

Every Computer publication, a staging `-dev.N` build as well as a stable
production version, carries release notes. The Web shows them as "What's new
in v{version}" next to the Computer upgrade button, so a user can see what an
upgrade brings before taking it.

## Who writes them, and what they hold

Agents write and publish the notes as part of running the release workflows;
there is no editor page. Each publication needs both languages:

- English (`en`) and Simplified Chinese (`zh-CN`), each Markdown.
- Written for the people who use the Computer: what changed for them, what
  they should do, what got fixed. Not a list of commit subjects, PR numbers,
  or internal module names.
- Only `coforge-computer` and `coforge-daemon` changes. The Web, backend,
  cloud, and other components are not installed by the Computer and never
  appear in the notes.
- At most 16000 characters per language after trimming surrounding
  whitespace, counted as JavaScript string length (UTF-16 code units). A
  blank language is refused.

Notes describe what changed since the previous production version. A dev
build's notes therefore cover its whole release line so far, not just the
builds since the previous dev build, and the production version that ships the
line can reuse them unchanged.

## Release catalog

The notes live in the release catalog, a self-contained module of the Web
service for now. Each environment has its own catalog at its Web origin:
`https://staging.coforge.cn` for staging, `https://coforge.cn` for production.
The Computer's app slug is `coforge-computer`.

| Request | Path | Result |
| --- | --- | --- |
| `PUT`, `Authorization: Bearer <token>`, body `{ "notes": { "en", "zh-CN" } }` | `/api/release-catalog/v1/apps/{app}/releases/{version}` | 200 with `{ app, version, notes, updatedAt }`; 400 `invalid_request`; 401; 503 `publishing_disabled` when the catalog has no publish token |
| `GET`, public | the same path | 200 with the same body; 404 `not_found` |

A `PUT` replaces the version's notes, so the notes stay editable after the
publication. The publish tokens are the repository secrets
`COFORGE_RELEASE_CATALOG_TOKEN_STAGING` and
`COFORGE_RELEASE_CATALOG_TOKEN_PRODUCTION`.

## How a publication registers them

`scripts/release/release-notes.ts` is the one client. It reads the notes from
`RELEASE_NOTES_EN` and `RELEASE_NOTES_ZH_CN` and the token from
`COFORGE_RELEASE_CATALOG_TOKEN`, never from arguments, `PUT`s the notes, then
reads them back with a public `GET` and fails unless the stored notes equal
what it sent. It retries a network error or a 5xx answer twice, but not a 4xx
or `publishing_disabled`, and it logs the version, app, sizes and outcome,
never the token or the notes. With `--check` it only validates the inputs.

`release-staging.yml` and `release-production.yml` take the notes as the
`notes_en` and `notes_zh_cn` inputs and hand them to the script through env
vars only:

1. Before anything is published, `--check` refuses a missing, blank, or
   oversized note: in staging's `notes-check` job, which runs beside the gates
   and which the publish job also needs, and in production's `candidate` job
   ahead of the approval gate. A staging withdrawal needs no notes, which is
   why staging's inputs are optional in the workflow schema.
2. After the publication has moved `latest`, a separate `notes` job calls
   `release-notes.yml` to register the notes for the version actually
   published (staging's auto-numbered version comes from the publish job's
   output) and verify the read-back. The caller passes only its own
   environment's token; that reusable workflow is the one place that maps an
   environment to its catalog origin; it holds no OSS credential and no
   `production` Environment.

If the `notes` job fails, the release is already live without notes. Do not
republish: rerun the failed job (`gh run rerun <run-id> --failed`), or
register them with `release-notes.yml`.

## Passing the notes

Write each language to a file and pass its content as one input; a multi-line
value is fine:

```sh
gh workflow run release-staging.yml --repo lrm-lab/coforge \
  -f notes_en="$(cat notes.en.md)" -f notes_zh_cn="$(cat notes.zh-CN.md)"
```

GitHub limits a dispatch's inputs to 65,535 characters in total, so two
maximum-length notes fit together with the other inputs
([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).

## Editing after publication

Dispatched by hand, `release-notes.yml` rewrites the notes of a published
version. It takes `environment` (`staging` or `production`), `version`,
`notes_en`, and `notes_zh_cn`, runs only from `main`, and changes notes text
alone: it holds no OSS credential and does not use the `production`
Environment, so it needs no approval.

```sh
gh workflow run release-notes.yml --repo lrm-lab/coforge \
  -f environment=staging -f version=0.1.3-dev.4 \
  -f notes_en="$(cat notes.en.md)" -f notes_zh_cn="$(cat notes.zh-CN.md)"
```

## Production reuses the staging candidate's notes

A production version promotes a staging candidate
([Staging to production](staging-to-production.md#local-computer-distribution)).
Read the candidate's notes from the staging catalog and pass the same text to
`release-production.yml`:

```sh
curl -s https://staging.coforge.cn/api/release-catalog/v1/apps/coforge-computer/releases/0.1.3-dev.4 \
  | jq -r '.notes.en' > notes.en.md
curl -s https://staging.coforge.cn/api/release-catalog/v1/apps/coforge-computer/releases/0.1.3-dev.4 \
  | jq -r '.notes["zh-CN"]' > notes.zh-CN.md
```
