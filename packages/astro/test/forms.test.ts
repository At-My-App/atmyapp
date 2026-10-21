import { resolveForm } from "../src/forms";
const makeClient = (status: any) =>
  ({
    submissions: {
      getTypeStatus: jest.fn(async () => status),
      getFormParams: jest.fn(async (_name, options) => ({
        action:
          "https://api.example/forms/contact?returnTo=" +
          encodeURIComponent(options.returnTo || ""),
        method: "POST",
        encType: "multipart/form-data",
      })),
    },
  }) as any;
it("does not provision or send forms while previewing", async () => {
  const client = makeClient(null);
  expect(
    (await resolveForm(client, "contact", { preview: true })).enabled,
  ).toBe(false);
  expect(client.submissions.getTypeStatus).not.toHaveBeenCalled();
});
it("renders the configured captcha widget unless the page brings its own", async () => {
  const status = {
    acceptingResponses: true,
    requiresCaptcha: true,
    captcha: { provider: "turnstile", siteKey: "0x4AAA" },
  };
  const auto = await resolveForm(makeClient(status), "contact");
  expect(auto).toMatchObject({
    enabled: true,
    captcha: { className: "cf-turnstile", siteKey: "0x4AAA", invisible: false },
  });
  const custom = await resolveForm(makeClient(status), "contact", { hasCaptcha: true });
  expect(custom).toMatchObject({ enabled: true, captcha: null });
});
it("handles closed and CAPTCHA forms", async () => {
  expect(
    (await resolveForm(makeClient({ acceptingResponses: false }), "contact"))
      .enabled,
  ).toBe(false);
  expect(
    (
      await resolveForm(
        makeClient({ acceptingResponses: true, requiresCaptcha: true }),
        "contact",
      )
    ).enabled,
  ).toBe(false);
});
it("resolves relative return URLs without requiring a browser", async () => {
  const client = makeClient({ acceptingResponses: true });
  const value = await resolveForm(client, "contact", {
    returnTo: "/thanks?amaPreviewKey=secret",
    site: new URL("https://site.example"),
  });
  expect(value).toMatchObject({ enabled: true, honeypot: true });
  expect(client.submissions.getFormParams).toHaveBeenCalledWith("contact", {
    returnTo: "https://site.example/thanks",
  });
});
it("rejects off-site return targets", async () => {
  await expect(
    resolveForm(makeClient({ acceptingResponses: true }), "contact", {
      returnTo: "//other.example",
      site: new URL("https://site.example"),
    }),
  ).rejects.toThrow("configured website");
});
