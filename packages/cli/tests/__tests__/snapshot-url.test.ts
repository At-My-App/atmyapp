import { getSnapshotApiUrl } from "../../src/cli/commands/snapshot";

describe("snapshot URLs", () => {
  it("use the session's host instead of a fixed one", () => {
    expect(getSnapshotApiUrl("https://staging-api.atmyapp.com/v0/projects/p1", "p1", "snapshot")).toBe(
      "https://staging-api.atmyapp.com/v0/work-container/projects/p1/snapshot",
    );
    expect(getSnapshotApiUrl("https://api.atmyapp.com", "p 1", "latest-snapshot")).toBe(
      "https://api.atmyapp.com/v0/work-container/projects/p%201/latest-snapshot",
    );
  });
});
