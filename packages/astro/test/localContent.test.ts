import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalContentFile } from "../src/localContent";

describe("local content route", () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "ama-astro-content-"));
    root = join(base, ".ama", "content");
    mkdirSync(join(root, "spring", "f"), { recursive: true });
    writeFileSync(join(root, "spring", "f", "hero new.png"), "png");
    writeFileSync(join(root, "spring", "f", "a%20b.png"), "encoded on disk");
    writeFileSync(join(root, ".lock"), "{}");
    writeFileSync(join(base, "secret.txt"), "outside");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("serves files inside the store, decoding each segment once", () => {
    expect(resolveLocalContentFile(root, "/spring/f/hero%20new.png")).toMatch(/hero new\.png$/);
    // Names on disk are already encoded by the store; the URL encodes them again.
    expect(resolveLocalContentFile(root, "/spring/f/a%2520b.png?x=1")).toMatch(/a%20b\.png$/);
  });

  it("refuses traversal, symbolic-link escapes, directories and lock files", () => {
    expect(resolveLocalContentFile(root, "/../../secret.txt")).toBeNull();
    expect(resolveLocalContentFile(root, "/spring/%2e%2e/%2e%2e/%2e%2e/secret.txt")).toBeNull();
    expect(resolveLocalContentFile(root, "/spring/f%2F..%2F..%2F..%2Fsecret.txt")).toBeNull();
    symlinkSync(join(base, "secret.txt"), join(root, "spring", "f", "link.txt"));
    expect(resolveLocalContentFile(root, "/spring/f/link.txt")).toBeNull();
    expect(resolveLocalContentFile(root, "/spring/f")).toBeNull();
    expect(resolveLocalContentFile(root, "/.lock")).toBeNull();
    expect(resolveLocalContentFile(root, "/%E0%A4%A")).toBeNull();
  });
});
