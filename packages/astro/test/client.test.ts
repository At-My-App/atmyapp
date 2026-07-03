// @ts-nocheck

import { getClient, resetClientCache } from "../src/client";

describe("getClient", () => {
  beforeEach(() => {
    resetClientCache();
  });

  afterEach(() => {
    delete (globalThis as any).window;
    resetClientCache();
  });

  it("throws when called outside browser", () => {
    delete (globalThis as any).window;

    expect(() => getClient()).toThrow(
      "AtMyApp: getClient() called outside the browser.",
    );
  });

  it("throws when AtMyAppHead is missing", () => {
    (globalThis as any).window = {};

    expect(() => getClient()).toThrow(
      "AtMyApp: AtMyAppHead is missing from your layout",
    );
  });

  it("returns a memoized configured core client", () => {
    (globalThis as any).window = {
      __ATMYAPP__: {
        apiKey: "ama_pk_test",
        baseUrl: "http://localhost:8585",
      },
    };

    const first = getClient();
    const second = getClient();

    expect(first).toBe(second);
    expect(typeof first.analytics.trackEvent).toBe("function");
    expect(typeof first.systemConfig.get).toBe("function");
  });
});
