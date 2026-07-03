import { http, HttpResponse } from "msw";
import { createAtMyAppClient } from "../src/client/client";
import { API_BASE_URL } from "./handlers";
import { server } from "./server";

describe("Localization discovery client", () => {
  it("reads storage, collection, and entry locale summaries", async () => {
    server.use(
      http.get(`${API_BASE_URL}/storage/locales/:path`, () =>
        HttpResponse.json({
          success: true,
          data: { defaultLocale: "en", locales: [{ locale: "pl", status: "current" }] },
        }),
      ),
      http.get(`${API_BASE_URL}/collections/:collection/locales`, () =>
        HttpResponse.json({
          success: true,
          data: { defaultLocale: "en", locales: [{ locale: "pl", total: 2 }] },
        }),
      ),
      http.get(`${API_BASE_URL}/collections/:collection/entries/:entryId/locales`, () =>
        HttpResponse.json({
          success: true,
          data: { defaultLocale: "en", locales: [{ locale: "pl", status: "incomplete" }] },
        }),
      ),
    );

    const client = createAtMyAppClient({ apiKey: "k", baseUrl: API_BASE_URL });

    await expect(client.localization.getStorageLocales("terms.md")).resolves.toEqual({
      defaultLocale: "en",
      locales: [{ locale: "pl", status: "current" }],
    });
    await expect(client.localization.getCollectionLocales("posts")).resolves.toEqual({
      defaultLocale: "en",
      locales: [{ locale: "pl", total: 2 }],
    });
    await expect(
      client.localization.getCollectionEntryLocales("posts", "1"),
    ).resolves.toEqual({
      defaultLocale: "en",
      locales: [{ locale: "pl", status: "incomplete" }],
    });
  });
});
