import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiClient } from "../../src/runtime/api";
import { createProject } from "../../src/runtime/projects";
import { replaceWithArchive, SNAPSHOT_MARKER, snapshotDestination } from "../../src/runtime/snapshotFiles";

describe("snapshot download destination (§11.1 P1-7)", () => {
  let project: string;
  beforeEach(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), "ama-project-")); });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it("never replaces the project folder or anything above it, even with --force", () => {
    for (const output of [".", "..", project]) {
      expect(() => snapshotDestination(output, { cwd: project, force: true })).toThrow(expect.objectContaining({ code: "unsafe_snapshot_destination" }));
    }
  });

  it("refuses a folder holding other files unless --force, and accepts its own folders", () => {
    fs.mkdirSync(path.join(project, "notes"));
    fs.writeFileSync(path.join(project, "notes", "todo.md"), "keep me");
    expect(() => snapshotDestination("notes", { cwd: project })).toThrow(expect.objectContaining({ code: "unsafe_snapshot_destination" }));
    expect(snapshotDestination("notes", { cwd: project, force: true })).toBe(path.join(project, "notes"));
    expect(snapshotDestination(undefined, { cwd: project })).toBe(path.join(project, ".ama", "local"));
    fs.mkdirSync(path.join(project, "fallback"));
    fs.writeFileSync(path.join(project, "fallback", SNAPSHOT_MARKER), "");
    fs.writeFileSync(path.join(project, "fallback", "a.json"), "{}");
    expect(snapshotDestination("fallback", { cwd: project })).toBe(path.join(project, "fallback"));
  });

  it("keeps the previous snapshot when the archive is corrupt or can't be opened", () => {
    const target = path.join(project, ".ama", "local");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "old.json"), "previous");
    expect(() => replaceWithArchive("bad.zip", target, () => { throw new Error("End-of-central-directory signature not found"); }))
      .toThrow(expect.objectContaining({ code: "snapshot_extract_failed" }));
    expect(fs.readFileSync(path.join(target, "old.json"), "utf8")).toBe("previous");
    expect(fs.readdirSync(path.dirname(target))).toEqual(["local"]);
  });

  it("swaps in the new snapshot only once it is complete", () => {
    const target = path.join(project, ".ama", "local");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "old.json"), "previous");
    replaceWithArchive("good.zip", target, (_zip, into) => fs.writeFileSync(path.join(into, "new.json"), "fresh"));
    expect(fs.readdirSync(target).sort()).toEqual([SNAPSHOT_MARKER, "new.json"]);
    expect(fs.readdirSync(path.dirname(target))).toEqual(["local"]);
  });
});

describe("projects create on the last free slot (§11.2 P2-5)", () => {
  it("finds the project an interrupted run created instead of reporting the limit", async () => {
    const session = { token: "ama_cs_" + "a".repeat(64), projectId: "", url: "https://api.test" };
    const fetch = (async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/project-creation")) {
        return Response.json({ success: true, data: { destinations: [{ id: "bella", name: "Bella", via: "partner", partner: { id: "acme", name: "Acme" }, limitReached: true }] } });
      }
      return Response.json({ success: true, data: { projects: [{ id: "spring", name: "Spring", organization: { id: "bella", name: "Bella" }, via: "partner" }] } });
    }) as never;
    await expect(createProject(new ApiClient(session, { fetch }), { name: "Spring", org: "bella" }))
      .resolves.toMatchObject({ unchanged: true, project: { id: "spring" } });
    await expect(createProject(new ApiClient(session, { fetch }), { name: "Autumn", org: "bella" }))
      .rejects.toMatchObject({ code: "needs_person", details: { reason: "dashboard" } });
  });
});
