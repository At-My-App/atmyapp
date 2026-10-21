import { getContentApiUrl } from "../../src/cli/commands/init";

describe("getContentApiUrl", () => {
  it("maps the CLI host to the content host websites read from", () => {
    expect(
      getContentApiUrl("https://api.atmyapp.com/v0/projects/p1", "p1"),
    ).toBe("https://edge.atmyapp.com/v0/projects/p1");
    expect(
      getContentApiUrl("https://staging-api.atmyapp.com/v0/projects/p1", "p1"),
    ).toBe("https://staging-edge.atmyapp.com/v0/projects/p1");
  });

  it("returns null for unknown hosts and invalid URLs", () => {
    expect(getContentApiUrl("http://localhost:8787/v0/projects/p1", "p1")).toBeNull();
    expect(getContentApiUrl("not a url", "p1")).toBeNull();
  });
});
