import {
  BridgeRefusal,
  INVALID_PARAMS,
  requireText,
  viaHost,
  type BridgeKit,
  type CallTable,
} from "./artifact-page-bridge-core";
import { PAGE_ASSET_MAX_BYTES } from "./artifact-page-limits";

export function createAssetCalls(kit: BridgeKit): CallTable {
  return {
    "assets.list": async () => ((await viaHost(kit.assets.list())) as { assets: unknown }).assets,
    "assets.upload": async (args) => {
      const { file } = args;
      if (!(file instanceof Blob) || file.size === 0 || file.size > PAGE_ASSET_MAX_BYTES)
        throw new BridgeRefusal(INVALID_PARAMS, "A file of up to 10 MiB expected");
      const name = requireText(
        args.name ?? (file instanceof File ? file.name : undefined),
        "A file name",
        100,
      );
      await kit.confirm("assets", { kind: "upload", name, sizeBytes: file.size });
      return viaHost(kit.assets.upload(file, name));
    },
    "assets.delete": async (args) => {
      const name = requireText(args.name, "A file name", 100);
      await kit.confirm("assets", { kind: "delete", name });
      return viaHost(kit.assets.delete(name));
    },
  };
}
