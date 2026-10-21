import { readFile, readdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../dist/", import.meta.url));
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : path.join(dir, e.name),
      ),
    )
  ).flat();
}
const files = (await walk(root)).filter((f) => f.endsWith(".html"));
for (const file of files) {
  const html = await readFile(file, "utf8");
  // Redirect stubs for retired pages: only their target must exist.
  const redirect = html.match(/http-equiv="refresh" content="0;url=([^"#]*)/);
  if (redirect) {
    await access(path.join(root, redirect[1], "index.html")).catch(() => {
      throw new Error(`${file}: redirect to missing page ${redirect[1]}`);
    });
    continue;
  }
  assert.equal(
    (html.match(/<site-search[ >]/g) || []).length,
    1,
    `${file}: expected one search dialog`,
  );
  assert.equal(
    (html.match(/id="starlight__search"/g) || []).length,
    1,
    `${file}: expected one result container`,
  );
  for (const match of html.matchAll(/href="(\/[^"#?]*)[^" ]*"/g)) {
    if (match[1].startsWith("//")) continue;
    const target = decodeURIComponent(match[1]);
    const resolved = path.join(
      root,
      target,
      target.endsWith("/") ? "index.html" : "",
    );
    await access(resolved).catch(() => {
      throw new Error(`${file}: missing local link ${target}`);
    });
  }
  // Section links must point at a heading that exists.
  for (const match of html.matchAll(/href="(\/[^"#]*)#([^"]+)"/g)) {
    const target = path.join(root, decodeURIComponent(match[1]), "index.html");
    const targetHtml = await readFile(target, "utf8").catch(() => "");
    if (!targetHtml.includes(`id="${match[2]}"`))
      throw new Error(`${file}: missing anchor ${match[1]}#${match[2]}`);
  }
}
await access(path.join(root, "pagefind/pagefind.js"));
console.log(
  `Verified search markup and local links across ${files.length} pages.`,
);
