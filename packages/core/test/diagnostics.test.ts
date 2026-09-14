import {
  createDiagnosticsClient,
  createDiagnosticsHandler,
} from "../src/client/diagnostics";
const probe = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  checkedAt: new Date().toISOString(),
  projectId: "project",
  credentials: { status: "passed", code: "credentials_valid" },
  preview: {
    status: "unsupported",
    code: "preview_absent",
    identity: null,
    revision: null,
  },
  ...overrides,
});
const options = {
  apiKey: "pk-ama-private",
  baseUrl: "https://edge.example/v0/projects/project",
};
describe("optional integration diagnostics", () => {
  it("does not run until requested and never serializes credentials", async () => {
    const customFetch = jest
      .fn()
      .mockResolvedValue(
        Response.json({ ...probe(), apiKey: "server-secret" }),
      );
    const diagnostics = createDiagnosticsClient({
      ...options,
      previewKey: "signed.secret",
      customFetch,
    });
    expect(customFetch).not.toHaveBeenCalled();
    const report = await diagnostics.report();
    expect(report.checks.credentials.status).toBe("passed");
    expect(report.content.fallbackUsed).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(
      /pk-ama-private|signed.secret|server-secret/,
    );
    expect(customFetch.mock.calls[0][1].headers["X-AtMyApp-Preview"]).toBe(
      "signed.secret",
    );
  });
  it("does not contact the API in local-only mode", async () => {
    const customFetch = jest.fn();
    const report = await createDiagnosticsClient({
      ...options,
      clientMode: "local",
      customFetch,
    }).report();
    expect(report.checkedAt).toBeNull();
    expect(report.checks.credentials.status).toBe("unknown");
    expect(customFetch).not.toHaveBeenCalled();
  });
  it("does not hide credential failure behind fallback mode", async () => {
    const customFetch = jest.fn().mockResolvedValue(
      Response.json(
        probe({
          credentials: { status: "failed", code: "credentials_rejected" },
        }),
      ),
    );
    const report = await createDiagnosticsClient({
      ...options,
      clientMode: "with-fallback",
      customFetch,
    }).report();
    expect(report.checks.credentials.status).toBe("failed");
    expect(report.content.fallbackUsed).toBeNull();
  });
  it("labels build evidence and filters metadata", async () => {
    const customFetch = jest.fn().mockResolvedValue(Response.json(probe()));
    const report = await createDiagnosticsClient({
      ...options,
      customFetch,
    }).report({
      execution: "build",
      codeCommit: "a".repeat(40),
      astroVersion: "1.2.3",
    });
    expect(report.execution).toBe("build");
    expect(report.builtAt).toBe(report.generatedAt);
    expect(report.codeCommit).toBe("a".repeat(40));
    expect(report.sdk.astro).toBe("1.2.3");
  });
  it("supports older backends without marking a site broken", async () => {
    const customFetch = jest
      .fn()
      .mockResolvedValue(new Response("", { status: 404 }));
    expect(
      (await createDiagnosticsClient({ ...options, customFetch }).report())
        .checks.connection.status,
    ).toBe("unsupported");
  });
  it("rejects HTML and oversized JSON", async () => {
    for (const response of [
      new Response("<html>Starting</html>"),
      Response.json({ ...probe(), padding: "x".repeat(65536) }),
    ]) {
      const customFetch = jest.fn().mockResolvedValue(response);
      expect(
        (await createDiagnosticsClient({ ...options, customFetch }).report())
          .checks.connection.code,
      ).toBe("invalid_report");
    }
  });
  it("bounds custom fetch implementations that ignore abort signals", async () => {
    jest.useFakeTimers();
    const customFetch = jest.fn(() => new Promise<Response>(() => {}));
    const pending = createDiagnosticsClient({
      ...options,
      customFetch,
    }).report();
    await jest.advanceTimersByTimeAsync(5001);
    expect((await pending).checks.connection.code).toBe("timeout");
    jest.useRealTimers();
  });
  it("uses isolated clients for simultaneous previews", async () => {
    const customFetch = jest.fn(async (_url: any, init: any) =>
      Response.json(
        probe({
          preview: {
            status: "passed",
            code: "preview_valid",
            identity:
              init.headers["X-AtMyApp-Preview"] === "one"
                ? "a".repeat(64)
                : "b".repeat(64),
            revision: 1,
          },
        }),
      ),
    );
    const handler = createDiagnosticsHandler((request) => ({
      diagnostics: createDiagnosticsClient({
        ...options,
        customFetch,
        previewKey:
          new URL(request.url).searchParams.get("amaPreviewKey") || undefined,
      }),
    }));
    const responses = await Promise.all(
      ["one", "two"].map((key) =>
        handler(
          new Request(
            `https://site.example/.well-known/atmyapp/diagnostics.json?amaPreviewKey=${key}`,
          ),
        ),
      ),
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(bodies.map((body) => body.preview.identity)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(responses[0].headers.get("cache-control")).toBe("no-store");
  });
});
