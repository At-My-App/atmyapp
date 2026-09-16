import { createSystemConfigClient } from "../src/client/systemConfig";
it("forwards preview context and disables metadata response caching", async () => {
  let received: URL | undefined;
  let headers: Headers | undefined;
  const client = createSystemConfigClient({
    apiKey: "public",
    baseUrl: "https://api.example/v0/projects/project",
    previewKey: "preview-A",
    customFetch: async (input, init) => {
      received = new URL(String(input));
      headers = new Headers(init?.headers);
      return Response.json({
        success: true,
        data: {
          systemKey: "website.metadata",
          config: { title: "Draft" },
        },
      });
    },
  });
  const result = await client.get({
    systemKey: "website.metadata",
  });
  expect(result.config).toEqual({ title: "Draft" });
  expect(received!.searchParams.get("amaPreviewKey")).toBe("preview-A");
  expect(headers!.get("Cache-Control")).toBe("no-store");
});
