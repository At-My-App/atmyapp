import { http, HttpResponse } from "msw";
import { createAtMyAppClient } from "../src/client/client";
import { API_BASE_URL, default_system_config } from "./handlers";
import { server } from "./server";

describe("System config client", () => {
  let client: ReturnType<typeof createAtMyAppClient>;

  beforeEach(() => {
    client = createAtMyAppClient({
      apiKey: "test-api-key",
      baseUrl: API_BASE_URL,
    });
  });

  it("returns website system configuration", async () => {
    const result = await client.systemConfig.get({
      systemKey: "website.metadata",
    });

    expect(result).toEqual(default_system_config);
  });

  it("throws enriched errors for failed requests", async () => {
    await expect(
      client.systemConfig.get({
        systemKey: "error",
      })
    ).rejects.toThrow('AtMyApp: failed to fetch system config "error"');
  });

  it("wraps network failures", async () => {
    server.use(
      http.get(`${API_BASE_URL}/system-config/network_error`, () => {
        return HttpResponse.error();
      })
    );

    await expect(
      client.systemConfig.get({
        systemKey: "network_error",
      })
    ).rejects.toThrow('AtMyApp: failed to fetch system config "network_error"');
  });
});
