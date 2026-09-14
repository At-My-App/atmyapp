import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { build, dev } from "astro";
const root = new URL("./fixtures/website/", import.meta.url);
const mode = process.argv[2] || "static";
let revision = 1;
const api = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = url.searchParams.get("amaPreviewKey");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname.endsWith("/diagnostics"))
    return res.end(
      JSON.stringify({
        version: 1,
        projectId: "project",
        credentials: { code: "credentials_valid" },
        preview: {
          code:
            req.headers["x-atmyapp-preview"] === "INVALID"
              ? "preview_invalid"
              : req.headers["x-atmyapp-preview"]
                ? "preview_valid"
                : "preview_absent",
          identity: "a".repeat(64),
          revision,
        },
      }),
    );
  if (url.pathname.includes("/storage/f/"))
    return res.end(
      JSON.stringify({
        text: key ? `Content ${key} ${revision}` : "Published content",
      }),
    );
  if (url.pathname.includes("/system-config/"))
    return res.end(
      JSON.stringify({
        success: true,
        data: {
          config: {
            title: "Website",
            titleTemplate: "%s | Brand",
            description: key ? `Preview ${key} ${revision}` : "Published",
            jsonLd: { text: "</script><script>bad()</script>" },
          },
        },
      }),
    );
  if (url.pathname.endsWith("/submissions/types"))
    return res.end(
      JSON.stringify({
        success: true,
        data: [
          {
            type: "contact",
            accepting_responses: true,
            requires_captcha: false,
          },
        ],
      }),
    );
  if (url.pathname.endsWith("/form-url"))
    return res.end(
      JSON.stringify({
        success: true,
        data: { formUrl: "https://forms.example/contact" },
      }),
    );
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
process.env.ATMYAPP_API_URL = `http://127.0.0.1:${api.address().port}/v0/projects/project`;
process.env.ATMYAPP_API_KEY = "public-fixture";
process.env.DEV_MODE = mode === "static" ? "false" : "true";
let server;
try {
  if (mode === "static") {
    await build({ root });
    const html = await readFile(new URL("dist/index.html", root), "utf8");
    assert.match(html, /Home \| Brand/);
    assert.match(html, /Published/);
    assert.match(html, /action="https:\/\/forms.example/);
    assert.doesNotMatch(html, /<script>bad/);
    assert.doesNotMatch(html, /addEventListener/);
    const enhanced = await readFile(
      new URL("dist/enhanced/index.html", root),
      "utf8",
    );
    assert.match(enhanced, /data-atmyapp-enhance/);
    assert.match(enhanced, /addEventListener/);
    const report = JSON.parse(
      await readFile(
        new URL("dist/.well-known/atmyapp/diagnostics.json", root),
        "utf8",
      ),
    );
    assert.equal(report.execution, "build");
  } else if (mode === "server-build") {
    process.env.ASTRO_TEST_SSR = "1";
    await build({ root });
    const child = spawn(
      process.execPath,
      [new URL("dist/server/entry.mjs", root).pathname],
      {
        env: { ...process.env, HOST: "127.0.0.1", PORT: "4399" },
        stdio: "pipe",
      },
    );
    const closed = new Promise((resolve) => child.once("close", resolve));
    let logs = "";
    child.stderr.on("data", (data) => {
      logs += data;
    });
    try {
      let response;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          response = await fetch(
            "http://127.0.0.1:4399/?amaPreviewKey=SERVER",
            { signal: AbortSignal.timeout(2000) },
          );
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.ok(response, logs || "Production server did not start");
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Preview SERVER 1/);
      const report = await (
        await fetch(
          "http://127.0.0.1:4399/.well-known/atmyapp/diagnostics.json?amaPreviewKey=SERVER",
        )
      ).json();
      assert.equal(report.execution, "runtime");
    } finally {
      child.kill();
      await closed;
      if (logs) console.log(logs);
    }
    console.log("Dynamic production server passed");
  } else {
    server = await dev({ root, server: { host: "127.0.0.1", port: 4398 } });
    const origin = `http://127.0.0.1:${server.address.port}`;
    const [a, b] = await Promise.all(
      ["A", "B"].map(async (key) =>
        (await fetch(origin + "/?amaPreviewKey=" + key)).text(),
      ),
    );
    assert.match(a, /Preview A 1/);
    assert.match(a, /Content A 1/);
    assert.match(b, /Content B 1/);
    assert.doesNotMatch(a, /Preview B/);
    assert.match(b, /Preview B 1/);
    assert.match(a, /noindex, nofollow/);
    assert.match(a, /disabled in previews/);
    assert.doesNotMatch(a, /action="https:\/\/forms.example/);
    const invalid = await fetch(origin + "/?amaPreviewKey=INVALID");
    assert.equal(invalid.status, 500);
    revision = 2;
    assert.match(
      await (await fetch(origin + "/?amaPreviewKey=A")).text(),
      /Preview A 2/,
    );
    const report = await (
      await fetch(
        origin + "/.well-known/atmyapp/diagnostics.json?amaPreviewKey=A",
      )
    ).json();
    assert.equal(report.execution, "runtime");
    assert.equal(report.preview.revision, 2);
  }
  console.log(`${mode} website smoke passed`);
} finally {
  await server?.stop();
  await new Promise((resolve) => api.close(resolve));
}
