import { resolveDevMode, resolveClientOptions } from "../src/config";
const env = {
  ATMYAPP_API_KEY: "public-key",
  ATMYAPP_API_URL: "https://api.example.com/v0/projects/project",
};
describe("Astro configuration", () => {
  it("defaults dev to dynamic and builds to static", () => {
    expect(resolveDevMode({}, true)).toBe(true);
    expect(resolveDevMode({})).toBe(false);
  });
  it.each(["1", "true", "TRUE"])("accepts truth %s", (value) =>
    expect(resolveDevMode({ DEV_MODE: value })).toBe(true),
  );
  it("prefers DEV_MODE even when false", () =>
    expect(resolveDevMode({ DEV_MODE: "false", IS_DYNAMIC: "1" }, true)).toBe(
      false,
    ));
  it("supports the alias and rejects ambiguous values", () => {
    expect(resolveDevMode({ IS_DYNAMIC: "1" })).toBe(true);
    expect(() => resolveDevMode({ DEV_MODE: "yes" })).toThrow();
  });
  it("resolves explicit, request and environment previews without static query reads", () => {
    const source = { ...env, ATMYAPP_PREVIEW_KEY: "environment" };
    const url = new URL("https://preview.example/?amaPreviewKey=request");
    expect(resolveClientOptions(source, url, true).previewKey).toBe("request");
    expect(resolveClientOptions(source, url, false).previewKey).toBe(
      "environment",
    );
    expect(
      resolveClientOptions(source, url, true, { previewKey: null }).previewKey,
    ).toBeUndefined();
    expect(
      resolveClientOptions(source, url, true, { previewKey: "explicit" })
        .previewKey,
    ).toBe("explicit");
  });
  it("supports the hosting URL alias and requires configuration", () => {
    expect(resolveClientOptions(env, undefined, false).baseUrl).toBe(
      env.ATMYAPP_API_URL,
    );
    expect(() => resolveClientOptions({}, undefined, false)).toThrow(
      "ATMYAPP_API_KEY",
    );
  });
});
