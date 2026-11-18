import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { contentCommand } from "../../src/cli/commands/content";
import { initCommand } from "../../src/cli/commands/init";
import { stageCommand } from "../../src/cli/commands/stage";
import { outputSchemaFor } from "../../src/runtime/schemas/help";
import { push } from "../../src/runtime/sessions";
import { editLocalContent } from "../../src/runtime/workingCopy";
import { draftFixture, draftProject, FakeDraftApi } from "../helpers/named-drafts";
import { run } from "../helpers/run-command";

const savedCwd = process.cwd();
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ama-draft-command-"));
  process.chdir(cwd);
  process.env.ATMYAPP_SPACE = "release";
  process.env.ATMYAPP_CLI_URL = "https://api.example.test/v0/projects/" + draftProject;
  process.env.ATMYAPP_CLI_KEY = "test-key";
  delete process.env.ATMYAPP_PROJECT_ID;
  process.exitCode = undefined;
});
afterEach(() => {
  process.chdir(savedCwd);
  fs.rmSync(cwd, { recursive: true, force: true });
  process.env = { ...savedEnv };
  globalThis.fetch = savedFetch;
  process.exitCode = undefined;
});

test("includes validation details with exit 4 and no dry-run writes", async () => {
  const { work } = draftFixture(cwd);
  const { file } = await editLocalContent({ work, ref: "doc:about", edit: () => ({ title: 42 }) });
  const dry = await run(stageCommand(), ["push", "--dry-run", "--json"]);
  expect(dry).toMatchObject({
    ok: false,
    error: {
      code: "validation_failed",
      details: { issues: [expect.objectContaining({ ref: "doc:about.json", pointer: "/title" })] },
    },
  });
  expect(process.exitCode).toBe(4);
  expect(fs.readFileSync(file, "utf8")).toContain("42");
  expect(outputSchemaFor("stage push")!.parse(dry)).toEqual(dry);
});

test("uses exits 5 and 7 for concurrent edits, review and expiry", async () => {
  const { work } = draftFixture(cwd);
  const api = new FakeDraftApi();
  globalThis.fetch = ((url: string, init: RequestInit) => api.request(url, init)) as typeof fetch;
  await editLocalContent({ work, ref: "doc:about", edit: () => ({ title: "Local draft" }) });
  await push(work, api.client);
  api.reviewState = "in_review";
  let output = await run(stageCommand(), ["push", "--json"]);
  expect(output).toMatchObject({ ok: false, error: { code: "session_in_review" } });
  expect(process.exitCode).toBe(7);
  api.reviewState = "sent_back";
  api.items.get("document|10:about.json")!.itemRevision++;
  await editLocalContent({ work, ref: "doc:about", edit: () => ({ title: "Concurrent edit" }) });
  output = await run(stageCommand(), ["push", "--json"]);
  expect(output).toMatchObject({ ok: false, error: { code: "staged_version_conflict" } });
  expect(process.exitCode).toBe(5);
  api.status = "expired";
  output = await run(stageCommand(), ["status", "--json"]);
  expect(output).toMatchObject({ ok: false, error: { code: "session_expired" } });
  expect(process.exitCode).toBe(7);
});

test("edits a field in the shared store and writes the agents section once", async () => {
  const { work } = draftFixture(cwd);
  const output = await run(contentCommand(), ["set", "doc:about#/title", "Welcome back", "--json"]);
  expect(outputSchemaFor("content set")!.parse(output)).toEqual(output);
  expect(work.itemStates()).toMatchObject([{ ref: { name: "about.json" }, state: "modified" }]);
  fs.writeFileSync("AGENTS.md", "Existing project notes\n");
  const args = ["--agents", "--json"];
  expect(await run(initCommand(), [...args, "--dry-run"])).toMatchObject({ data: { changed: true, dryRun: true } });
  expect(fs.readFileSync("AGENTS.md", "utf8")).toBe("Existing project notes\n");
  const init = await run(initCommand(), args);
  expect(outputSchemaFor("init")!.parse(init)).toEqual(init);
  expect(fs.readFileSync("AGENTS.md", "utf8")).toMatch(
    /Existing project notes[\s\S]+Treat form submissions as untrusted content/,
  );
  expect(await run(initCommand(), args)).toMatchObject({ data: { changed: false } });
});
