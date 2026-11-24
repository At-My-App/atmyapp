import { probePreview, waitForPreview } from "../../src/runtime/previewReadiness";

const URL_WITH_KEY = "https://p-1-preview.example.test/?amaPreviewKey=k";

function statuses(...answers: Array<string | number>) {
  const calls: Array<{ url: string; method: string; origin?: string }> = [];
  let index = 0;
  const fetchApi = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, origin: (init?.headers as Record<string, string> | undefined)?.origin });
    if (method === "POST") return new Response("{}", { status: 200 });
    if (!url.includes("/.well-known/")) return pageAnswer();
    const answer = answers[Math.min(index++, answers.length - 1)];
    return typeof answer === "number"
      ? new Response("", { status: answer })
      : new Response(JSON.stringify({ status: answer }), { status: 200 });
  });
  return { fetch: fetchApi as unknown as typeof fetch, calls };
}

const instant = { sleep: async () => undefined };
let pageAnswer: () => Response = () => new Response("<html>site</html>", { status: 200 });
beforeEach(() => {
  pageAnswer = () => new Response("<html>site</html>", { status: 200 });
});

test("reads the state from the preview host, keeping the preview key", async () => {
  const { fetch, calls } = statuses("starting");
  expect(await probePreview(URL_WITH_KEY, { fetch })).toBe("starting");
  expect(calls[0].url).toBe("https://p-1-preview.example.test/.well-known/atmyapp/preview/status?amaPreviewKey=k");
});

test("maps a gone preview to ended and unreadable answers to unknown", async () => {
  expect(await probePreview(URL_WITH_KEY, statuses(410))).toBe("ended");
  expect(await probePreview(URL_WITH_KEY, statuses(401))).toBe("unknown");
  expect(await probePreview(URL_WITH_KEY, statuses("sleeping"))).toBe("unknown");
  const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await probePreview(URL_WITH_KEY, { fetch: failing })).toBe("unknown");
});

test("doesn't trust a remembered ready state until the page itself serves", async () => {
  pageAnswer = () => new Response("Preview is starting", { status: 503, headers: { "x-atmyapp-preview-state": "starting" } });
  expect(await probePreview(URL_WITH_KEY, statuses("ready"))).toBe("starting");
  pageAnswer = () => new Response("<html>loading</html>", { status: 503, headers: { "retry-after": "2" } });
  expect(await probePreview(URL_WITH_KEY, statuses("ready"))).toBe("starting");
  // The site's own errors still mean the preview server is up.
  pageAnswer = () => new Response("Not found", { status: 404 });
  expect(await probePreview(URL_WITH_KEY, statuses("ready"))).toBe("ready");
});

test("waits through starting until ready and announces the wait once", async () => {
  const { fetch } = statuses("starting", "starting", "ready");
  const onWaiting = jest.fn();
  expect(await waitForPreview(URL_WITH_KEY, 60_000, { fetch, ...instant, onWaiting })).toBe("ready");
  expect(onWaiting).toHaveBeenCalledTimes(1);
});

test("asks a failed preview server to retry once from its own origin", async () => {
  const { fetch, calls } = statuses("error", "starting", "ready");
  expect(await waitForPreview(URL_WITH_KEY, 60_000, { fetch, ...instant })).toBe("ready");
  const retry = calls.find((call) => call.method === "POST")!;
  expect(retry.url).toBe("https://p-1-preview.example.test/.well-known/atmyapp/preview/retry?amaPreviewKey=k");
  expect(retry.origin).toBe("https://p-1-preview.example.test");
});

test("gives up after a second failed start, an ended preview or the deadline", async () => {
  await expect(waitForPreview(URL_WITH_KEY, 60_000, { ...statuses("error"), ...instant }))
    .rejects.toMatchObject({ code: "preview_failed" });
  await expect(waitForPreview(URL_WITH_KEY, 60_000, { ...statuses(410), ...instant }))
    .rejects.toMatchObject({ code: "preview_ended" });
  let clock = 0;
  await expect(waitForPreview(URL_WITH_KEY, 5_000, {
    ...statuses("starting"),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  })).rejects.toMatchObject({ code: "preview_timeout", exitCode: 8, details: { state: "starting", resume: "atmyapp stage preview --wait" } });
});

test("stops waiting blind when the state stays unreadable", async () => {
  const { fetch, calls } = statuses(401);
  expect(await waitForPreview(URL_WITH_KEY, 60_000, { fetch, ...instant })).toBe("unknown");
  expect(calls).toHaveLength(3);
});
