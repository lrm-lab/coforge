import { expect, test } from "bun:test";

test("the Web image carries one build id from build stage through runtime", async () => {
  const dockerfile = await Bun.file(new URL("../Dockerfile", import.meta.url)).text();
  expect(dockerfile).toContain("ARG COFORGE_BUILD_ID=development");
  expect(dockerfile).toContain("ENV COFORGE_BUILD_ID=$COFORGE_BUILD_ID");
});

test("staging passes the source SHA as the image build id", async () => {
  const workflow = await Bun.file(
    new URL("../../../.github/workflows/deploy-staging.yml", import.meta.url),
  ).text();
  expect(workflow).toContain("COFORGE_BUILD_ID=${{ github.sha }}");
});
