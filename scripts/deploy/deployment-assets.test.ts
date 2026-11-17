import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const sourcedByRemoteDeploy = [
  ...read("scripts/deploy/remote-deploy.sh").matchAll(
    /^source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/([\w.-]+)"$/gm,
  ),
].map((match) => `scripts/deploy/${match[1]}`);

const shippedBy = (workflow: string) => {
  const text = read(`.github/workflows/${workflow}`);
  const step = text.slice(text.indexOf("- name: Copy deployment assets"));
  const tar = step.slice(step.indexOf("tar -czf"), step.indexOf("ssh "));
  return [...tar.matchAll(/^\s+(\S+?)\s*\\?$/gm)].map((match) => match[1]);
};

describe("the files a deploy ships to the host", () => {
  test("remote-deploy.sh sources at least the scripts it is known to need", () => {
    expect(sourcedByRemoteDeploy).toContain("scripts/deploy/deploy-secrets.sh");
  });

  for (const workflow of ["deploy-staging.yml", "deploy-production.yml"])
    test(`${workflow} ships remote-deploy.sh and every script it sources`, () => {
      const shipped = shippedBy(workflow);
      for (const script of ["scripts/deploy/remote-deploy.sh", ...sourcedByRemoteDeploy])
        expect(shipped).toContain(script);
    });
});
