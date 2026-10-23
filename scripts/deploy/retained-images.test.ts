import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";

test("retained image deployment configuration reaches Compose without entering stdout", async () => {
  const script = await readFile(new URL("./remote-deploy.sh", import.meta.url), "utf8");
  const functions = script.slice(
    script.indexOf("load_compose_secrets()"),
    script.indexOf("# Fail closed on a mutable"),
  );
  const directory = await mkdtemp(join(tmpdir(), "coforge-github-deploy-"));
  try {
    for (const name of [
      "authing_app_id",
      "authing_app_secret",
      "coforge_session_secret",
      "coforge_agent_credential_encryption_key",
      "coforge_web_push_public_key",
      "coforge_web_push_private_key",
      "coforge_file_delivery_key",
      "centrifugo_token_hmac_secret_key",
    ])
      await writeFile(join(directory, name), "fixture");
    for (const configured of [false, true]) {
      if (configured) {
        await writeFile(join(directory, "coforge_github_client_secret"), "github-fixture");
        await writeFile(join(directory, "coforge_github_credential_encryption_key"), "key-fixture");
        await writeFile(join(directory, "coforge_github_app_slug"), "fixture-app");
        await writeFile(join(directory, "coforge_commit_coauthor"), "C <c@x.io>");
        await writeFile(join(directory, "coforge_github_webhook_secret"), "hook-fixture");
        await writeFile(join(directory, "coforge_retained_cloud_image_ids"), "image-fixture");
      }
      const child = Bun.spawn(
        [
          "bash",
          "-euc",
          `${functions}
        secrets_dir="$1"
        COMPOSE_ARGS=()
        docker() {
          test "\${COFORGE_GITHUB_CLIENT_SECRET-unset}" = "$2"
          test "\${COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY-unset}" = "$3"
          test "\${COFORGE_GITHUB_APP_SLUG-unset}" = "$4"
          test "\${COFORGE_COMMIT_COAUTHOR-unset}" = "$5"
          test "\${COFORGE_GITHUB_WEBHOOK_SECRET-unset}" = "$6"
          test "\${COFORGE_RETAINED_CLOUD_IMAGE_IDS-unset}" = "$7"
        }
        load_compose_secrets
        compose "$2" "$3" "$4" "$5" "$6" "$7"
      `,
          "test",
          directory,
          configured ? "github-fixture" : "",
          configured ? "key-fixture" : "",
          configured ? "fixture-app" : "",
          configured ? "C <c@x.io>" : "",
          configured ? "hook-fixture" : "",
          configured ? "image-fixture" : "",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe("");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
