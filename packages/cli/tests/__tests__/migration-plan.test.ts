import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  planNeedsConfirmation,
  readOperationsFile,
  suggestedClearFromPlan,
} from "../../src/cli/utils/migration-plan";
import {
  applyRemoteMigration,
  planRemoteMigration,
} from "../../src/runtime/migration";

const basePlan = {
  formatVersion: 1 as const,
  projectId: "p",
  branch: "main",
  baseHeadSha: "h",
  unchanged: false,
  operations: [],
  changes: [],
  actions: [],
  destructive: {
    issues: [],
    removedCollections: [],
    removedContentFiles: [],
    retainedColumns: [],
  },
  effects: { changedResources: [], samples: [] },
  content: { introduced: [], preexisting: [] },
  blocks: [],
  digest: "d",
};

describe("migration plan helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "ama-operations-"));
  const file = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };

  it("reads declared operations and rejects malformed ones", () => {
    const rename = { type: "renameField", definition: "posts", from: "a", to: "b" };
    expect(readOperationsFile(file("ok.json", [rename]))).toEqual([rename]);
    expect(() =>
      readOperationsFile(file("bad.json", [{ type: "renameField", definition: "posts" }])),
    ).toThrow("Operation 1");
    expect(() => readOperationsFile(file("object.json", rename))).toThrow("JSON array");
  });

  it("turns destructive issues into the matching clear request", () => {
    expect(
      suggestedClearFromPlan({
        ...basePlan,
        destructive: {
          ...basePlan.destructive,
          issues: [
            { kind: "collection_removal", collectionName: "posts", message: "" },
            { kind: "column_removal", collectionName: "a", columnName: "z", message: "" },
            { kind: "column_removal", collectionName: "a", columnName: "y", message: "" },
          ],
        },
      }),
    ).toEqual({
      collections: ["posts"],
      contentFiles: [],
      columns: [{ collection: "a", columns: ["y", "z"] }],
    });
  });

  it("asks for confirmation only when stored content is affected", () => {
    expect(planNeedsConfirmation(basePlan)).toBe(false);
    expect(
      planNeedsConfirmation({
        ...basePlan,
        effects: { changedResources: ["entry:posts:1"], samples: [] },
      }),
    ).toBe(true);
  });
});

describe("migration HTTP client", () => {
  const request = { output: { version: 1, definitions: {} } as any };

  it("targets the branch and returns the server plan", async () => {
    const fetchImplementation = jest.fn(async () =>
      new Response(JSON.stringify({ success: true, data: { plan: basePlan } })),
    );
    const result = await planRemoteMigration(
      { url: "https://api/v0/projects/p", token: "t", branch: "staging", fetchImplementation },
      request,
    );
    expect(result).toMatchObject({ ok: true, data: { plan: basePlan } });
    expect((fetchImplementation.mock.calls[0] as unknown[])[0]).toBe(
      "https://api/v0/projects/p/storage/structure/plan?branch=staging",
    );
  });

  it("treats network failures and server errors as uncertain, conflicts as definite", async () => {
    const target = (response: () => Promise<Response>) => ({
      url: "https://api",
      fetchImplementation: jest.fn(response) as unknown as typeof fetch,
    });
    const apply = (response: () => Promise<Response>) =>
      applyRemoteMigration(target(response), {
        ...request,
        planDigest: "d",
        operationId: "cli-1",
      });
    expect(await apply(() => Promise.reject(new Error("socket hang up")))).toMatchObject({
      ok: false,
      uncertain: true,
    });
    expect(await apply(async () => new Response("bad gateway", { status: 502 }))).toMatchObject({
      ok: false,
      uncertain: true,
    });
    expect(
      await apply(
        async () =>
          new Response(
            JSON.stringify({ success: false, data: { code: "PLAN_STALE" }, error: "stale" }),
            { status: 409 },
          ),
      ),
    ).toMatchObject({ ok: false, uncertain: false, code: "PLAN_STALE" });
  });
});
