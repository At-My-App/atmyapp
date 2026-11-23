import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContentStore, PUBLISHED } from "../../src/runtime/store";

describe("published copy for incremental pulls", () => {
  it("shares unchanged files and never changes the original through the copy", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ama-store-copy-"));
    try {
      const store = new ContentStore(cwd);
      store.writeJson(store.entryPath("posts", "e1"), { id: "e1", data: { title: "Old" } });
      store.writeBytes(store.filePath("files/big.bin"), Buffer.alloc(1024, 1));
      const next = store.withPublished(`${PUBLISHED}.next`);
      store.copyPublishedTo(next);

      next.writeJson(next.entryPath("posts", "e1"), { id: "e1", data: { title: "New" } });
      next.remove(next.filePath("files/big.bin"));

      expect(JSON.parse(fs.readFileSync(store.entryPath("posts", "e1"), "utf8")).data.title).toBe("Old");
      expect(fs.readFileSync(store.filePath("files/big.bin")).length).toBe(1024);
      expect(JSON.parse(fs.readFileSync(next.entryPath("posts", "e1"), "utf8")).data.title).toBe("New");
      expect(fs.existsSync(next.filePath("files/big.bin"))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
