import { parseDuration, waitTimeout, WAITS } from "../../src/runtime/duration";
import { CliError, EXIT, needsPerson, stillPending } from "../../src/runtime/errors";

test("parses seconds, minutes and hours within the limits", () => {
  const limits = { min: 5_000, max: 3_600_000 };
  expect(parseDuration("90s", limits)).toBe(90_000);
  expect(parseDuration("90", limits)).toBe(90_000);
  expect(parseDuration("5m", limits)).toBe(300_000);
  expect(parseDuration("1H", limits)).toBe(3_600_000);
  expect(() => parseDuration("1s", limits)).toThrow(/between 5s and 1h/);
  expect(() => parseDuration("2h", limits)).toThrow(CliError);
  expect(() => parseDuration("soon", limits)).toThrow(expect.objectContaining({ code: "invalid_timeout", exitCode: EXIT.usage }));
});

test("each kind of wait has its own default and longest wait", () => {
  expect(waitTimeout("deploy", undefined)).toBe(15 * 60_000);
  expect(waitTimeout("preview", undefined)).toBe(WAITS.preview.default);
  expect(waitTimeout("domain", "45m")).toBe(45 * 60_000);
  expect(() => waitTimeout("preview", "30m")).toThrow(/between 5s and 15m/);
});

test("needs_person and still-pending errors carry their reason and how to continue", () => {
  expect(needsPerson("dns", "Add the records.", { resume: "atmyapp domains check x --wait" }).toJSON()).toEqual({
    code: "needs_person",
    message: "Add the records.",
    fix: "Run 'atmyapp domains check x --wait' again once that's done.",
    details: { reason: "dns", resume: "atmyapp domains check x --wait" },
  });
  expect(needsPerson("browser", "Open the link.", { url: "https://x.test" }).exitCode).toBe(EXIT.confirmation);
  const pending = stillPending("deploy_timeout", "Still building.", { state: "building", resume: "atmyapp hosting logs r --follow" });
  expect(pending.exitCode).toBe(EXIT.pending);
  expect(pending.details).toEqual({ state: "building", resume: "atmyapp hosting logs r --follow" });
});

test("every exit-6 error says why a person is needed", () => {
  expect(new CliError("needs_confirmation", "Confirm.", { exitCode: EXIT.confirmation }).details).toEqual({ reason: "confirmation" });
  expect(new CliError("space_has_edits", "x", { exitCode: EXIT.confirmation, details: { space: "a" } }).details)
    .toEqual({ space: "a", reason: "confirmation" });
  expect(new CliError("other", "x").details).toBeUndefined();
});
