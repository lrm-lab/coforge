import {
  createEvalRuntime,
  provisionDisposableAccount,
  readSecretRootKey,
  rememberEvalAccountKey,
  rootIdentity,
  rotateEvalAdminKey,
  userIdentity,
} from "../../public-channel-memory/src/ov";
import { prepareKnowledge } from "./knowledge-import";

function required(key: string) {
  const value = Bun.env[key];
  if (!value) throw new Error(`missing ${key}`);
  return value;
}
const runtime = createEvalRuntime(Bun.env.COFORGE_OPENVIKING_URL ?? "http://127.0.0.1:1933");
const root = rootIdentity(await readSecretRootKey(required("OPENVIKING_PROTOTYPE_CONF")));
const accountId = required("COFORGE_KNOWLEDGE_ACCOUNT_ID");
if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error("invalid knowledge account id");
const settingsPath = Bun.env.COFORGE_KNOWLEDGE_ACCOUNT_SETTINGS;
const settings = settingsPath ? await Bun.file(settingsPath).json() : undefined;
const users =
  Bun.env.COFORGE_KNOWLEDGE_CREATE_ACCOUNT === "1"
    ? await provisionDisposableAccount(runtime, root, accountId, settings)
    : await rotateEvalAdminKey(runtime, root, accountId);
Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE ??= "/tmp/pcm-eval-ov-keys.json";
await rememberEvalAccountKey(accountId, users.adminKey);
const ready = await prepareKnowledge({
  runtime,
  identity: userIdentity(accountId, users.adminUserId, users.adminKey, "admin"),
  corpusPath: required("COFORGE_KNOWLEDGE_CORPUS"),
  ledgerPath: required("COFORGE_KNOWLEDGE_LEDGER"),
  readyPath: required("COFORGE_EVAL_KNOWLEDGE_READY"),
  expectedDocuments: Number(Bun.env.COFORGE_KNOWLEDGE_DOCUMENT_COUNT ?? "67707"),
  expectedExperiences: Number(Bun.env.COFORGE_KNOWLEDGE_EXPERIENCE_COUNT ?? "89"),
});
console.log(JSON.stringify(ready));
