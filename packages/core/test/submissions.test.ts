import {
  captchaWidget,
  createAtMyAppClient,
  SubmissionError,
} from "../src";
import {
  defineDocument,
  defineSchema,
  defineSubmission,
  s,
} from "@atmyapp/structure";
import { API_BASE_URL } from "./handlers";
import { server } from "./server";
import { http, HttpResponse } from "msw";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;

const schema = defineSchema({
  definitions: {
    settings: defineDocument({
      fields: {
        title: s.string(),
      },
    }),
  },
  submissions: {
    contact: defineSubmission({
      fields: {
        name: s.string(),
        email: s.email(),
        message: s.longText({ optional: true }),
        resume: s.file({ optional: true }),
      },
      captcha: {
        required: true,
        provider: "hcaptcha",
      },
    }),
  },
});

describe("Submissions client", () => {
  it("types schema-aware submission helpers from runtime schema", () => {
    const client = createAtMyAppClient({
      apiKey: "k",
      baseUrl: API_BASE_URL,
      schema,
    });

    if (false) {
      const submitPromise = client.submissions.submit("contact", new FormData());

      type SubmitResult = Awaited<typeof submitPromise>;
      type _submitResultNotAny = Assert<IsAny<SubmitResult> extends false ? true : false>;
      type _submitResultShape = Assert<
        SubmitResult extends { ok: true; submissionId: string } | { ok: false; error: { code: string } }
          ? true
          : false
      >;
      type FailureFields = keyof NonNullable<
        Extract<SubmitResult, { ok: false }>["error"]["fields"]
      >;
      type _typedFields = Assert<"email" extends FailureFields ? true : false>;

      const formParamsPromise = client.submissions.getFormParams("contact");
      type FormParams = Awaited<typeof formParamsPromise>;
      type _formParamsShape = Assert<
        FormParams extends { action: string; method: "POST" } ? true : false
      >;

      // @ts-expect-error missing required email field
      client.submissions.submit("contact", {
        name: "Ada",
      });

      // @ts-expect-error invalid submission name should not type-check
      client.submissions.getFormParams("missing");
    }

    expect(true).toBe(true);
  });

  it("returns accepting-responses status and form params", async () => {
    const client = createAtMyAppClient({
      apiKey: "k",
      baseUrl: API_BASE_URL,
      schema,
    });
    const genericClient = createAtMyAppClient({
      apiKey: "k",
      baseUrl: API_BASE_URL,
    });

    await expect(client.submissions.isAcceptingResponses("contact")).resolves.toBe(
      true
    );
    await expect(genericClient.submissions.isAcceptingResponses("closed")).resolves.toBe(
      false
    );
    await expect(genericClient.submissions.getTypeStatus("missing")).resolves.toBeNull();

    const formParams = await client.submissions.getFormParams("contact");
    expect(formParams).toEqual({
      action: "https://edge.atmyapp.com/forms/project/contact",
      method: "POST",
      encType: "multipart/form-data",
    });
  });

  it("supports absolute returnTo URLs in form params", async () => {
    const client = createAtMyAppClient({
      apiKey: "k",
      baseUrl: API_BASE_URL,
      schema,
    });

    const formParams = await client.submissions.getFormParams("contact", {
      returnTo: "https://www.example.com/thank-you?source=form",
    });

    expect(formParams).toEqual({
      action:
        "https://edge.atmyapp.com/forms/project/contact?returnTo=https%3A%2F%2Fwww.example.com%2Fthank-you%3Fsource%3Dform",
      method: "POST",
      encType: "multipart/form-data",
    });
  });

  it("resolves relative returnTo paths against the current origin", async () => {
    const originalLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
      value: { origin: "https://site.example.com" },
      configurable: true,
    });

    try {
      const client = createAtMyAppClient({
        apiKey: "k",
        baseUrl: API_BASE_URL,
        schema,
      });

      const formParams = await client.submissions.getFormParams("contact", {
        returnTo: "/thank-you",
      });

      expect(formParams.action).toBe(
        "https://edge.atmyapp.com/forms/project/contact?returnTo=https%3A%2F%2Fsite.example.com%2Fthank-you"
      );
    } finally {
      Object.defineProperty(globalThis, "location", {
        value: originalLocation,
        configurable: true,
      });
    }
  });

  it("submits plain JSON payloads for non-file submissions", async () => {
    let contentType: string | null = null;
    let receivedBody: unknown;

    server.use(
      http.post(`${API_BASE_URL}/submissions/:submissionType`, async ({ request, params }) => {
        if (params.submissionType !== "contact") {
          return HttpResponse.json({
            success: false,
            data: null,
            error: "Unexpected type",
          }, { status: 400 });
        }

        contentType = request.headers.get("content-type");
        receivedBody = await request.json();

        return HttpResponse.json({
          success: true,
          data: {
            submissionId: "contact-json-id",
          },
          error: "",
        });
      })
    );

    const client = createAtMyAppClient({
      apiKey: "k",
      baseUrl: API_BASE_URL,
      schema,
    });

    const result = await client.submissions.submit("contact", {
      name: "Ada",
      email: "ada@example.com",
      message: "Hello",
    });

    expect(result).toEqual({ ok: true, submissionId: "contact-json-id" });
    expect(contentType).toContain("application/json");
    expect(receivedBody).toEqual({
      name: "Ada",
      email: "ada@example.com",
      message: "Hello",
    });
  });

  it("serializes file payloads into multipart form data", async () => {
    let contentType: string | null = null;
    let dataField: string | null = null;
    let fileName: string | null = null;

    server.use(
      http.post(`${API_BASE_URL}/submissions/:submissionType`, async ({ request }) => {
        contentType = request.headers.get("content-type");
        const formData = await request.formData();
        dataField = formData.get("data") as string | null;
        const upload = formData.get("resume");
        fileName =
          upload && typeof upload === "object" && "name" in upload
            ? String((upload as File).name)
            : null;

        return HttpResponse.json({
          success: true,
          data: {
            submissionId: "contact-file-id",
          },
          error: "",
        });
      })
    );

    const client = createAtMyAppClient({
      apiKey: "k",
      baseUrl: API_BASE_URL,
      schema,
    });

    const resume = new File(["resume"], "resume.pdf", {
      type: "application/pdf",
    });

    const result = await client.submissions.submit("contact", {
      name: "Ada",
      email: "ada@example.com",
      resume,
    });

    expect(result).toEqual({ ok: true, submissionId: "contact-file-id" });
    expect(contentType).toContain("multipart/form-data");
    expect(fileName).toBe("resume.pdf");
    expect(JSON.parse(dataField || "{}")).toEqual({
      name: "Ada",
      email: "ada@example.com",
      resume: {
        name: "resume.pdf",
        mimeType: "application/pdf",
      },
    });
  });

  it("reads a stable form address from the type list without provisioning one", async () => {
    let formUrlRequests = 0;
    let typeRequests = 0;
    server.use(
      http.get(`${API_BASE_URL}/submissions/types`, async () => {
        typeRequests += 1;
        return HttpResponse.json({
          success: true,
          data: [
            {
              type: "contact",
              accepting_responses: true,
              captcha: { provider: "turnstile", siteKey: "0x4AAA" },
              honeypot: true,
              form_url: "https://edge.atmyapp.com/forms/project/form-id",
            },
          ],
          error: "",
        });
      }),
      http.post(`${API_BASE_URL}/submissions/:submissionType/form-url`, () => {
        formUrlRequests += 1;
        return HttpResponse.json({ success: true, data: { formUrl: "rotated" }, error: "" });
      })
    );

    const client = createAtMyAppClient({ apiKey: "k", baseUrl: API_BASE_URL });
    const status = await client.submissions.getTypeStatus("contact");
    const action = await client.submissions.getFormUrl("contact");

    expect(status).toMatchObject({
      requiresCaptcha: true,
      captchaProvider: "turnstile",
      captcha: { provider: "turnstile", siteKey: "0x4AAA" },
      honeypot: true,
    });
    expect(action).toBe("https://edge.atmyapp.com/forms/project/form-id");
    expect(formUrlRequests).toBe(0);
    expect(typeRequests).toBe(1);
  });

  it("sends idempotency and test headers and returns the test report", async () => {
    let idempotencyKey: string | null = null;
    let testHeader: string | null = null;
    server.use(
      http.post(`${API_BASE_URL}/submissions/:submissionType`, async ({ request }) => {
        idempotencyKey = request.headers.get("idempotency-key");
        testHeader = request.headers.get("x-ama-test");
        return HttpResponse.json({
          success: true,
          data: {
            submissionId: "s1",
            report: { steps: [{ step: "store", ok: true, detail: "Stored." }] },
          },
          error: "",
        });
      })
    );

    const client = createAtMyAppClient({ apiKey: "k", baseUrl: API_BASE_URL });
    const result = await client.submissions.submit(
      "contact",
      { name: "Ada" },
      { idempotencyKey: "key-1", test: true }
    );

    expect(idempotencyKey).toBe("key-1");
    expect(testHeader).toBe("1");
    expect(result.ok && result.report?.steps[0]).toMatchObject({ step: "store", ok: true });
  });

  it("returns refusals as values with the stable code, field errors and retry hint", async () => {
    let requests = 0;
    server.use(
      http.post(`${API_BASE_URL}/submissions/:submissionType`, () => {
        requests += 1;
        return HttpResponse.json(
          {
            success: false,
            data: null,
            error: "Some fields are missing or invalid.",
            code: "validation_failed",
            fields: { email: "invalid_format" },
          },
          { status: 422 }
        );
      })
    );
    const client = createAtMyAppClient({ apiKey: "k", baseUrl: API_BASE_URL });
    const result = await client.submissions.submit("contact", { email: "nope" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(SubmissionError);
    expect(result.error).toMatchObject({ code: "validation_failed", status: 422, fields: { email: "invalid_format" } });
    expect(result.error.retryable).toBe(false);
    expect(requests).toBe(1);

    server.use(
      http.post(`${API_BASE_URL}/submissions/:submissionType`, () =>
        HttpResponse.json(
          { success: false, data: null, error: "Too many submissions.", code: "rate_limited" },
          { status: 429, headers: { "Retry-After": "60" } }
        )
      )
    );
    const limited = await client.submissions.submit("contact", { name: "Ada" });
    expect(limited).toMatchObject({ ok: false, error: { code: "rate_limited", retryAfter: 60, retryable: true } });
  });

  it("checks fields against the schema before sending", async () => {
    let requests = 0;
    server.use(
      http.post(`${API_BASE_URL}/submissions/:submissionType`, () => {
        requests += 1;
        return HttpResponse.json({ success: true, data: { submissionId: "s" }, error: "" });
      })
    );
    const client = createAtMyAppClient({ apiKey: "k", baseUrl: API_BASE_URL, schema });

    expect(client.submissions.validate("contact", { name: "Ada", email: "not-an-email" })).toEqual({
      ok: false,
      checked: true,
      fields: { email: "invalid_format" },
    });
    const form = new FormData();
    form.set("name", "Ada");
    form.set("email", "   ");
    expect(client.submissions.validate("contact", form)).toMatchObject({ ok: false, fields: { email: "required" } });

    const refused = await client.submissions.submit("contact", { name: "", email: "ada@example.com" } as any);
    expect(refused).toMatchObject({ ok: false, error: { code: "validation_failed", status: 0, fields: { name: "required" } } });
    expect(requests).toBe(0);

    const sent = await client.submissions.submit("contact", { name: "", email: "x" } as any, { validate: false });
    expect(sent.ok).toBe(true);
    expect(requests).toBe(1);

    const generic = createAtMyAppClient({ apiKey: "k", baseUrl: API_BASE_URL });
    expect(generic.submissions.validate("contact", {})).toEqual({ ok: true, checked: false });
  });

  it("retries lost connections and brief outages with one idempotency key", async () => {
    const keys: Array<string | null> = [];
    let calls = 0;
    const client = createAtMyAppClient({
      apiKey: "k",
      baseUrl: API_BASE_URL,
      customFetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        keys.push(new Headers(init?.headers).get("idempotency-key"));
        if (calls === 1) throw new TypeError("Network request failed");
        if (calls === 2)
          return new Response(JSON.stringify({ success: false, data: null, error: "Try again", code: "try_again" }), {
            status: 503,
            headers: { "Retry-After": "0" },
          });
        return new Response(JSON.stringify({ success: true, data: { submissionId: "s9" }, error: "" }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await client.submissions.submit("contact", { name: "Ada" });
    expect(result).toEqual({ ok: true, submissionId: "s9" });
    expect(calls).toBe(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBeTruthy();

    calls = 0;
    const offline = createAtMyAppClient({
      apiKey: "k",
      baseUrl: API_BASE_URL,
      customFetch: (async () => {
        calls += 1;
        throw new TypeError("Network request failed");
      }) as typeof fetch,
    });
    const failed = await offline.submissions.submit("contact", { name: "Ada" }, { retry: 1 });
    expect(failed).toMatchObject({ ok: false, error: { code: "network_error", status: 0, retryable: true } });
    expect(calls).toBe(2);
  });

  it("reports a cancelled submission as aborted", async () => {
    const controller = new AbortController();
    const client = createAtMyAppClient({
      apiKey: "k",
      baseUrl: API_BASE_URL,
      customFetch: (async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }) as typeof fetch,
    });
    const result = await client.submissions.submit("contact", { name: "Ada" }, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
  });

  it("reports upload progress through XMLHttpRequest when asked", async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    class FakeXhr {
      status = 0;
      responseText = "";
      upload: { onprogress?: (event: any) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      private url = "";
      private headers: Record<string, string> = {};
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      }
      getResponseHeader() {
        return null;
      }
      abort() {
        this.onabort?.();
      }
      send() {
        sent.push({ url: this.url, headers: this.headers });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
        this.status = 200;
        this.responseText = JSON.stringify({ success: true, data: { submissionId: "up-1" }, error: "" });
        this.onload?.();
      }
    }
    (globalThis as any).XMLHttpRequest = FakeXhr;
    try {
      const client = createAtMyAppClient({ apiKey: "k", baseUrl: API_BASE_URL });
      const progress: number[] = [];
      const result = await client.submissions.submit(
        "contact",
        { name: "Ada", resume: new File(["x"], "cv.pdf", { type: "application/pdf" }) },
        { onUploadProgress: ({ fraction }) => progress.push(fraction) }
      );
      expect(result).toEqual({ ok: true, submissionId: "up-1" });
      expect(progress).toEqual([0.5, 1]);
      expect(sent[0].url).toBe(`${API_BASE_URL}/submissions/contact`);
      expect(sent[0].headers.authorization).toBe("Bearer k");
    } finally {
      delete (globalThis as any).XMLHttpRequest;
    }
  });

  it("adds a captcha token from a self-rendered widget without touching the caller's data", async () => {
    let jsonBody: any;
    let formToken: FormDataEntryValue | null = null;
    server.use(
      http.post(`${API_BASE_URL}/submissions/:submissionType`, async ({ request }) => {
        if ((request.headers.get("content-type") ?? "").includes("application/json")) {
          jsonBody = await request.json();
        } else {
          formToken = (await request.formData()).get("captchaToken");
        }
        return HttpResponse.json({ success: true, data: { submissionId: "s" }, error: "" });
      })
    );
    const client = createAtMyAppClient({ apiKey: "k", baseUrl: API_BASE_URL });

    const data = { name: "Ada" };
    await client.submissions.submit("contact", data, { captchaToken: "tok" });
    expect(jsonBody).toEqual({ name: "Ada", captchaToken: "tok" });
    expect(data).toEqual({ name: "Ada" });

    const form = new FormData();
    form.set("name", "Ada");
    await client.submissions.submit("contact", form, { captchaToken: "tok2" });
    expect(formToken).toBe("tok2");
    expect(form.has("captchaToken")).toBe(false);
  });

  it("describes how to render each captcha widget", () => {
    expect(captchaWidget({ provider: "turnstile", siteKey: "0x4" })).toMatchObject({
      scriptSrc: "https://challenges.cloudflare.com/turnstile/v0/api.js",
      className: "cf-turnstile",
      tokenField: "cf-turnstile-response",
      invisible: false,
    });
    expect(captchaWidget({ provider: "recaptcha", siteKey: "6L key", version: "v3" })).toMatchObject({
      scriptSrc: "https://www.google.com/recaptcha/api.js?render=6L%20key",
      invisible: true,
    });
    expect(captchaWidget({ provider: "recaptcha", siteKey: "6L", version: "v2" }).invisible).toBe(false);
  });
});
