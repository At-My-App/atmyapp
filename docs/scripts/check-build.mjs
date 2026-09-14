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
}
await access(path.join(root, "pagefind/pagefind.js"));
console.log(
  `Verified search markup and local links across ${files.length} pages.`,
);
