import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { build, dev } from "astro";
const root = new URL("./fixtures/diagnostics/", import.meta.url);
if (process.argv.includes("--dev")) {
  const server = await dev({ root, server: { host: "127.0.0.1", port: 4397 } });
  try {
    const reports = await Promise.all(
      ["", "?amaPreviewKey=fixture-capability"].map(async (query) => {
        const response = await fetch(
          `http://127.0.0.1:${server.address.port}/.well-known/atmyapp/diagnostics.json${query}`,
        );
        assert.equal(response.status, 200);
        return response.json();
      }),
    );
    assert.equal(reports[0].execution, "runtime");
    assert.equal(reports[0].checks.preview.status, "unsupported");
    assert.equal(reports[1].checks.preview.status, "passed");
    assert.equal(JSON.stringify(reports).includes("fixture-capability"), false);
    assert.equal(
      JSON.stringify(reports).includes("fixture-private-key"),
      false,
    );
  } finally {
    await server.stop();
  }
} else {
  await build({ root });
  const report = JSON.parse(
    await readFile(
      new URL("dist/.well-known/atmyapp/diagnostics.json", root),
      "utf8",
    ),
  );
  assert.equal(report.execution, "build");
  assert.equal(report.checks.credentials.status, "passed");
  // Astro build sets process-wide production state; dev needs a fresh process.
  const child = spawnSync(
    process.execPath,
    [new URL(import.meta.url).pathname, "--dev"],
    { stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } },
  );
  assert.equal(child.status, 0);
}
