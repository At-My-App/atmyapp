import {
  formatSubmissionChange,
  tailSubmissions,
  TailAccessError,
  type SubmissionChange,
} from "../../src/cli/commands/submissions";

const session = { token: "cli-key", projectId: "p1", url: "https://api.example.com/v0/projects/p1" };
const at = "2026-10-20T14:02:11.000Z";

const created = (env: "live" | "test", data: Record<string, unknown>, email: string | null): SubmissionChange => ({
  type: "contact",
  event: { seq: 1, at, actor: "public", kind: "created", submissionId: "3f9c1a2b-0000", payload: null },
  submission: {
    id: "3f9c1a2b-0000",
    env,
    status: "open",
    contact: { email, name: null },
    data,
    files: [{ name: "cv.pdf" }],
    signals: { strippedFields: ["utm_source"] },
  },
});

describe("formatSubmissionChange", () => {
  it("shows test submissions in full and rejections with their reason", () => {
    const line = formatSubmissionChange(created("test", { message: "Hello, I'd like a quote" }, "jan@example.com"));
    expect(line).toMatch(/contact {2}✔ received 3f9c1a2b {2}test {2}jan@example.com {2}"Hello, I'd like a quote" {2}1 file {2}dropped: utm_source$/);
    expect(
      formatSubmissionChange({
        type: "contact",
        event: { seq: 2, at, actor: "public", kind: "rejected", submissionId: null, payload: { reason: "captcha_expired", env: "dev", origin: "http://localhost:4321" } },
      })
    ).toMatch(/✖ rejected {2}captcha_expired {2}dev {2}origin=http:\/\/localhost:4321$/);
  });

  it("keeps redacted live submissions to id, env and file count, and skips read receipts", () => {
    expect(formatSubmissionChange(created("live", {}, null))).toMatch(/✔ received 3f9c1a2b {2}live {2}1 file/);
    expect(
      formatSubmissionChange({
        type: "contact",
        event: { seq: 3, at, actor: "user:u1", kind: "read", submissionId: "s1", payload: null },
      })
    ).toBeNull();
  });
});

describe("tailSubmissions", () => {
  const page = (changes: SubmissionChange[], cursor: string) =>
    new Response(JSON.stringify({ success: true, data: { changes, cursor }, error: "" }), { status: 200 });

  it("shows the backlog, then follows the cursor", async () => {
    const urls: string[] = [];
    const seen: number[] = [];
    const controller = new AbortController();
    const responses = [
      page([created("test", {}, null), { ...created("test", {}, null), event: { ...created("test", {}, null).event, seq: 2 } }], "c1"),
      new Response("{}", { status: 502 }),
      page([{ ...created("test", {}, null), event: { ...created("test", {}, null).event, seq: 3 } }], "c2"),
    ];
    const warnings: string[] = [];
    await tailSubmissions({
      session,
      type: "contact",
      backlog: 1,
      intervalMs: 10,
      signal: controller.signal,
      sleep: async () => undefined,
      onWarning: (message) => warnings.push(message),
      fetchImpl: (async (url: string) => {
        urls.push(url);
        const next = responses.shift();
        if (!next) {
          controller.abort();
          return page([], "c2");
        }
        return next;
      }) as typeof fetch,
      onChange: (change) => seen.push(change.event.seq),
    });
    expect(seen).toEqual([2, 3]);
    expect(urls[0]).toBe("https://api.example.com/v0/projects/p1/submissions/changes?limit=1&types=contact");
    expect(urls[2]).toContain("cursor=c1");
    expect(warnings).toHaveLength(1);
  });

  it("asks for live data only when requested and stops on a refused key", async () => {
    const urls: string[] = [];
    await tailSubmissions({
      session,
      backlog: 5,
      intervalMs: 10,
      once: true,
      includeLiveData: true,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return page([], "c0");
      }) as typeof fetch,
      onChange: () => undefined,
    });
    expect(urls[0]).toContain("includeLiveData=1");

    await expect(
      tailSubmissions({
        session,
        backlog: 5,
        intervalMs: 10,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: "Access denied" }), { status: 403 })) as unknown as typeof fetch,
        onChange: () => undefined,
      })
    ).rejects.toBeInstanceOf(TailAccessError);
  });
});
