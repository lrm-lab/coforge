# Recovering the binary and its source

The release authority is the Hands API, not the CDN. Read the official [Hands
Public API Reference](https://app.hands.build/docs/public-api-reference/) and
pin **1.0.45** before downloading an artifact. Record the selected target,
release id, binary hash, and observation date in the research note.

## Download and verify

1. Resolve the release with a version-pinned `updates/check` request:

   ```sh
   H=https://hands.build/public/v2/apps/raft-computer-cli
   curl -fsSL "$H/updates/check?product_type=cli-binary&platform=darwin&arch=arm64&current_version=0.0.0&current_version_code=0&version=1.0.45"
   ```

   Use the returned artifact `download_url` and `sha256`. Do not copy a
   release id or hash from an older research note. The unpinned `latest`
   endpoint is useful for discovery but does not prove that the artifact is
   1.0.45.

2. Download the selected gzip asset, verify it against the release metadata,
   and retain the sidecar metadata if one is supplied:

   ```sh
   curl -fsSL -o raft.gz '<official-1.0.45-download-url>'
   gunzip raft.gz
   shasum -a 256 raft
   ```

   The official installer also verifies its installer binary. Keep the binary
   and extracted tree in session scratch space; never commit either to this
   repository.

3. The user-facing install path can pin the same version:

   ```sh
   curl -fsSL https://cdn.raft.build/computer/install.sh | RAFT_COMPUTER_VERSION=1.0.45 sh
   ```

   Read the installer source or release metadata first and record the exact
   asset it selects. Do not use an unpinned `latest` artifact as 1.0.45 evidence.

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

2. Strip the SEA header by locating the 1.0.45 banner:

   ```python
   blob = open("sea.bin", "rb").read()
   start = blob.find(b"/* raft-computer SEA bundle v1.0.45 */")
   if start < 0:
       raise SystemExit("wrong artifact: v1.0.45 banner not found")
   open("raft-computer-1.0.45.cjs", "wb").write(blob[start:])
   ```

   Confirm the banner says `v1.0.45` before drawing any implementation
   conclusion. Record the extracted bundle hash separately from the binary
   hash.

3. Split the bundle at path comments: lines matching
   `^// (packages|node_modules)/\S+$`, for example
   `// packages/computer/src/cli.ts` or `// node_modules/.pnpm/<dep>/...`.
   Write the text from one marker to the next into a file at that path. Other
   `//` comments are not markers; append when a path marker repeats.

Do this in the session scratchpad. Never commit the binary or the extracted
tree to this repository.
