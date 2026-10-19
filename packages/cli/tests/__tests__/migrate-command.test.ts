jest.mock("../../src/cli/utils", () => {
  const conflicts = jest.requireActual("../../src/cli/utils/migration-conflicts");
  const plans = jest.requireActual("../../src/cli/utils/migration-plan");
  return {
    getMigrateConfig: jest.fn(),
    Logger: jest.requireActual("../../src/cli/logger").Logger,
    buildClearRequestFromOptions: conflicts.buildClearRequestFromOptions,
    mergeClearRequests: conflicts.mergeClearRequests,
    logMigrationConflictGuidance: jest.fn(),
    findCanonicalSchemaFile: jest.fn(),
    loadCanonicalSchemaFile: jest.fn(),
    ensureAmaDirectory: jest.fn(),
    saveOutputToFile: jest.fn(),
    uploadDefinitions: jest.fn(),
    logMigrationPlan: jest.fn(),
    planNeedsConfirmation: plans.planNeedsConfirmation,
    suggestedClearFromPlan: plans.suggestedClearFromPlan,
    readOperationsFile: jest.fn(),
    saveMigrationRecord: jest.fn(),
    readMigrationRecord: jest.fn(),
  };
});

jest.mock("../../src/runtime", () => ({
  runCanonicalMigrate: jest.fn(),
  planRemoteMigration: jest.fn(),
  applyRemoteMigration: jest.fn(),
  getRemoteMigrationStatus: jest.fn(),
  reconcileRemoteMigration: jest.fn(),
}));

import {
  migrateCommand,
  migrateStatusCommand,
} from "../../src/cli/commands/migrate";
import {
  findCanonicalSchemaFile,
  getMigrateConfig,
  loadCanonicalSchemaFile,
  logMigrationConflictGuidance,
  readMigrationRecord,
  readOperationsFile,
  saveMigrationRecord,
  uploadDefinitions,
} from "../../src/cli/utils";
import {
  applyRemoteMigration,
  getRemoteMigrationStatus,
  planRemoteMigration,
  reconcileRemoteMigration,
  runCanonicalMigrate,
} from "../../src/runtime";

const output = { version: 1, definitions: {} };
function plan(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    projectId: "project-1",
    branch: "main",
    baseHeadSha: "head-1",
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
    digest: "digest-1",
    ...overrides,
  };
}
const planned = (value = plan()) => ({
  ok: true,
  status: 200,
  data: { plan: value },
});
const run = (...args: string[]) =>
  migrateCommand().parseAsync(["node", "migrate", ...args]);

describe("migrate command", () => {
  let exit: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    exit = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    (getMigrateConfig as jest.Mock).mockReturnValue({
      url: "https://edge.atmyapp.test",
      token: "cli-ama-valid",
    });
    (findCanonicalSchemaFile as jest.Mock).mockResolvedValue(
      "/tmp/atmyapp.schema.ts",
    );
    (loadCanonicalSchemaFile as jest.Mock).mockResolvedValue({
      definitions: {},
    });
    (runCanonicalMigrate as jest.Mock).mockResolvedValue({ output });
  });

  afterEach(() => exit.mockRestore());

  it("plans against the server, then applies exactly that plan under a new operation", async () => {
    (planRemoteMigration as jest.Mock).mockResolvedValue(planned());
    (applyRemoteMigration as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      data: { updated: true },
    });

    await run("--branch", "staging");

    expect(planRemoteMigration).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "staging" }),
      expect.objectContaining({ output, operations: [] }),
    );
    const applied = (applyRemoteMigration as jest.Mock).mock.calls[0][1];
    expect(applied).toMatchObject({ planDigest: "digest-1" });
    expect(applied.operationId).toMatch(/^cli-/);
    expect(applied.acceptWarnings).toBe(true);
    // The operation is recorded before the request, so a lost response can be checked.
    expect(saveMigrationRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: applied.operationId,
        planDigest: "digest-1",
        url: "https://edge.atmyapp.test",
        branch: "staging",
        output,
        operations: [],
      }),
    );
    expect(JSON.stringify((saveMigrationRecord as jest.Mock).mock.calls[0][0])).not.toContain(
      "cli-ama-valid",
    );
    expect(
      (saveMigrationRecord as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan((applyRemoteMigration as jest.Mock).mock.invocationCallOrder[0]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not apply a plan that rewrites content without --yes in a non-interactive run", async () => {
    (planRemoteMigration as jest.Mock).mockResolvedValue(
      planned(plan({ effects: { changedResources: ["entry:posts:1"], samples: [] } })),
    );
    await run();
    expect(applyRemoteMigration).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("applies declared operations with --yes", async () => {
    const operations = [
      { type: "renameField", definition: "posts", from: "title", to: "headline" },
    ];
    (readOperationsFile as jest.Mock).mockReturnValue(operations);
    (planRemoteMigration as jest.Mock).mockResolvedValue(
      planned(plan({ effects: { changedResources: ["entry:posts:1"], samples: [] } })),
    );
    (applyRemoteMigration as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      data: { updated: true },
    });
    await run("--operations", "rename.json", "--yes");
    expect(readOperationsFile).toHaveBeenCalledWith("rename.json");
    expect((applyRemoteMigration as jest.Mock).mock.calls[0][1].operations).toBe(
      operations,
    );
  });

  it("stops on a blocked plan and shows the destructive guidance", async () => {
    (planRemoteMigration as jest.Mock).mockResolvedValue(
      planned(
        plan({
          blocks: [{ code: "destructive-change", message: "Posts still has data" }],
          destructive: {
            issues: [
              { kind: "collection_removal", collectionName: "posts", message: "x" },
            ],
            removedCollections: ["posts"],
            removedContentFiles: [],
            retainedColumns: [],
          },
        }),
      ),
    );
    await run();
    expect(logMigrationConflictGuidance).toHaveBeenCalled();
    expect(applyRemoteMigration).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("plans again with suggested clears when the dangerous flag is set", async () => {
    (planRemoteMigration as jest.Mock)
      .mockResolvedValueOnce(
        planned(
          plan({
            blocks: [{ code: "destructive-change", message: "x" }],
            destructive: {
              issues: [
                { kind: "content_removal", definitionName: "homepage", message: "x" },
                {
                  kind: "column_removal",
                  collectionName: "authors",
                  columnName: "bio",
                  message: "x",
                },
              ],
              removedCollections: [],
              removedContentFiles: ["homepage"],
              retainedColumns: [],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(planned(plan({ digest: "digest-2" })));
    (applyRemoteMigration as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      data: { updated: true },
    });

    await run("--clear-collection", "posts", "--dangerously-resolve-all-conflicts", "--yes");

    expect((planRemoteMigration as jest.Mock).mock.calls[1][1].clear).toEqual({
      collections: ["posts"],
      contentFiles: ["homepage"],
      columns: [{ collection: "authors", columns: ["bio"] }],
    });
    expect((applyRemoteMigration as jest.Mock).mock.calls[0][1].planDigest).toBe(
      "digest-2",
    );
  });

  it("reports an unconfirmed apply as unknown instead of failed", async () => {
    (planRemoteMigration as jest.Mock).mockResolvedValue(planned());
    (applyRemoteMigration as jest.Mock).mockResolvedValue({
      ok: false,
      uncertain: true,
      error: "socket hang up",
    });
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = jest.spyOn(console, "log").mockImplementation(() => undefined);
    await run();
    const printed = [...errors.mock.calls, ...logs.mock.calls].flat().join("\n");
    expect(printed).toContain("migrate-status cli-");
    expect(exit).toHaveBeenCalledWith(1);
    errors.mockRestore();
    logs.mockRestore();
  });

  it("falls back to the direct upload on servers without migration plans", async () => {
    (planRemoteMigration as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
      error: "Not found",
    });
    (uploadDefinitions as jest.Mock).mockResolvedValue({ success: true });
    await run();
    expect(uploadDefinitions).toHaveBeenCalledTimes(1);
    expect(applyRemoteMigration).not.toHaveBeenCalled();
  });

  it("compiles locally without contacting the server on --dry-run", async () => {
    await run("--dry-run");
    expect(getMigrateConfig).toHaveBeenCalledWith(process.cwd(), {
      allowMissingSession: true,
    });
    expect(planRemoteMigration).not.toHaveBeenCalled();
    expect(uploadDefinitions).not.toHaveBeenCalled();
  });

  it("prints exactly one JSON document on stdout with --json", async () => {
    (planRemoteMigration as jest.Mock).mockResolvedValue(planned());
    (applyRemoteMigration as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      data: { updated: true },
    });
    const stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logs = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await run("--json");
    const printed = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(JSON.parse(printed)).toMatchObject({ status: "applied" });
    expect(logs).not.toHaveBeenCalled();
    stdout.mockRestore();
    logs.mockRestore();
    errors.mockRestore();
  });
});

describe("migrate-status command", () => {
  let exit: jest.SpyInstance;
  let stdout: jest.SpyInstance;
  let errors: jest.SpyInstance;
  const status = (...args: string[]) =>
    migrateStatusCommand().parseAsync(["node", "migrate-status", ...args]);
  const record = {
    formatVersion: 1,
    operationId: "cli-recorded-operation",
    planDigest: "digest-1",
    url: "https://edge.atmyapp.test/project-a",
    branch: "main",
    output: { version: 1, definitions: { posts: {} } },
    operations: [
      { type: "renameField", definition: "posts", from: "title", to: "headline" },
    ],
    acceptWarnings: true,
    startedAt: "2026-10-19T00:00:00.000Z",
  };
  const printed = () =>
    stdout.mock.calls.map(([chunk]: [unknown]) => String(chunk)).join("");

  beforeEach(() => {
    jest.resetAllMocks();
    exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    (getMigrateConfig as jest.Mock).mockReturnValue({
      url: record.url,
      token: "cli-ama-valid",
    });
    (readMigrationRecord as jest.Mock).mockReturnValue(record);
    (getRemoteMigrationStatus as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      data: { status: "committed", operationId: record.operationId, commitSha: "abc" },
    });
  });

  afterEach(() => {
    exit.mockRestore();
    stdout.mockRestore();
    errors.mockRestore();
  });

  it("prints valid JSON only", async () => {
    await status("--json");
    expect(JSON.parse(printed())).toMatchObject({ status: "committed" });
    expect(exit).not.toHaveBeenCalled();
  });

  it("reconciles with the recorded schema and operations, not the current files", async () => {
    (reconcileRemoteMigration as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      data: { status: "committed", reconcileNeeded: false },
    });
    await status("--reconcile", "--json");
    expect(reconcileRemoteMigration).toHaveBeenCalledWith(
      expect.objectContaining({ url: record.url, branch: "main" }),
      record.operationId,
      { output: record.output, operations: record.operations, clear: undefined },
    );
    expect(runCanonicalMigrate).not.toHaveBeenCalled();
    expect(JSON.parse(printed())).toMatchObject({ reconcileNeeded: false });
  });

  it("refuses to check a migration against a different project", async () => {
    (getMigrateConfig as jest.Mock).mockReturnValue({
      url: "https://edge.atmyapp.test/project-b",
      token: "other",
    });
    await status("--json");
    expect(getRemoteMigrationStatus).not.toHaveBeenCalled();
    expect(JSON.parse(printed())).toMatchObject({
      status: "error",
      error: expect.stringContaining("project-a"),
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
