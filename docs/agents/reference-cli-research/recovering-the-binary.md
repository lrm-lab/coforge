# Recovering the binary and its source

The release authority is the Hands API, not the CDN. Read the official [Hands
Public API Reference](https://app.hands.build/docs/public-api-reference/) and
resolve the latest release before downloading an artifact. Record the resolved
version, target, release id, binary hash, and observation date in the research
note.

## Download and verify

1. Resolve the latest release with an `updates/check` request that names no
   version:

   ```sh
   H=https://hands.build/public/v2/apps/raft-computer-cli
   curl -fsSL "$H/updates/check?product_type=cli-binary&platform=darwin&arch=arm64&current_version=0.0.0&current_version_code=0"
   ```

   Its `release.version` is the version under study. Use the returned artifact
   `download_url` and `sha256`; do not copy a release id or hash from an older
   research note. To re-check an earlier conclusion against the release it
   cites, add `&version=<x.y.z>`.

2. Download the selected gzip asset, verify it against the release metadata,
   and retain the sidecar metadata if one is supplied:

   ```sh
   curl -fsSL -o raft.gz '<download_url from step 1>'
   gunzip raft.gz
   shasum -a 256 raft
   ```

   The official installer also verifies its installer binary. Keep the binary
   and extracted tree in session scratch space; never commit either to this
   repository.

3. The user-facing install path can select the same version:

   ```sh
   curl -fsSL https://cdn.raft.build/computer/install.sh | RAFT_COMPUTER_VERSION=<version from step 1> sh
   ```

   Read the installer source or release metadata first and record the exact
   asset it selects.

## Extract the source

The binary is a Node.js single-executable application (SEA): a stock Node
binary with a plain-text JS bundle injected by postject into a `NODE_SEA`
segment, rather than a V8 snapshot or code cache.

1. Locate the blob and cut it out.

   ```sh
   otool -l raft | grep -A8 'sectname __NODE_SEA_BLOB'
   ```

   Slice the file at the reported section `offset` for its `size`. The
   `NODE_SEA` segment `fileoff` and `filesize` identify the same bytes. On Linux
   use `readelf -S` and `NODE_SEA_BLOB`; on Windows it is a resource of the
   same name. Record offsets in the research note because they are artifact
   specific.

2. Strip the SEA header by locating the banner of the version resolved in
   step 1:

   ```python
   version = "x.y.z"  # release.version from step 1
   blob = open("sea.bin", "rb").read()
   start = blob.find(f"/* raft-computer SEA bundle v{version} */".encode())
   if start < 0:
       raise SystemExit(f"wrong artifact: v{version} banner not found")
   open(f"raft-computer-{version}.cjs", "wb").write(blob[start:])
   ```

   Confirm the banner names the resolved version before drawing any
   implementation conclusion. Record the extracted bundle hash separately from
   the binary hash.

3. Split the bundle at path comments: lines matching
   `^// (packages|node_modules)/\S+$`, for example
   `// packages/computer/src/cli.ts` or `// node_modules/.pnpm/<dep>/...`.
   Write the text from one marker to the next into a file at that path. Other
   `//` comments are not markers; append when a path marker repeats.

Do this in the session scratchpad. Never commit the binary or the extracted
tree to this repository.
