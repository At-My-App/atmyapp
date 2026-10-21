import {
  AtMyAppClientOptions,
  SubmissionCaptcha,
  SubmissionCaptchaProvider,
  SubmissionCaptchaWidget,
  SubmissionsClient,
  SubmissionFormEncType,
  SubmissionFormOptions,
  SubmissionFormParams,
  SubmissionResult,
  SubmissionSubmitOptions,
  SubmissionTypeStatus,
  SubmissionValidationResult,
} from "./clientTypes";
import { SubmissionError, type SubmissionErrorCode, type SubmissionFieldErrors } from "./submissionError";
import { formDataToObject, validateSubmissionData } from "./submissionValidation";
import {
  compileSchema,
  type Definition,
  type FieldDefinition,
  type SchemaDocument,
} from "@atmyapp/structure";

type ApiEnvelope<T> = {
  success: boolean;
  data: T;
  error: string;
  code?: string;
  fields?: Record<string, string>;
};

type SubmissionTypeRecord = {
  type: string;
  accepting_responses?: boolean | null;
  requires_captcha?: boolean | null;
  captcha_provider?: SubmissionCaptchaProvider | null;
  captcha?: SubmissionCaptcha | null;
  honeypot?: boolean | null;
  form_url?: string | null;
  /** Older servers only. */
  static_form_url?: string | null;
};

export {
  SUBMISSION_HONEYPOT_FIELD,
  SUBMISSION_RENDERED_AT_FIELD,
  captchaWidget,
} from "./captchaWidget";
import { CAPTCHA_TOKEN_FIELD } from "./captchaWidget";

/** How long one client reuses the submission type list. */
const TYPES_CACHE_MS = 5_000;

export { SubmissionError };

/** Retries after a lost connection or a brief outage; the idempotency key makes them safe. */
const DEFAULT_RETRIES = 2;
const RETRY_DELAYS_MS = [400, 1200, 3000];
const MAX_RETRY_WAIT_MS = 5000;

function newIdempotencyKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

const isAbort = (error: unknown) =>
  Boolean(error && typeof error === "object" && (error as { name?: string }).name === "AbortError");

interface TransportResponse {
  status: number;
  ok: boolean;
  retryAfter: number | undefined;
  json(): Promise<unknown>;
}

type Transport = (
  url: string,
  init: {
    headers: Record<string, string>;
    body: BodyInit;
    signal?: AbortSignal;
    onUploadProgress?: SubmissionSubmitOptions["onUploadProgress"];
  }
) => Promise<TransportResponse>;

const parseRetryAfter = (value: string | null) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

function fetchTransport(fetchImpl: typeof fetch): Transport {
  return async (url, init) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    return {
      status: response.status,
      ok: response.ok,
      retryAfter: parseRetryAfter(response.headers.get("retry-after")),
      json: () => response.json(),
    };
  };
}

/** XMLHttpRequest, the only browser API that reports upload progress. */
const xhrTransport: Transport = (url, init) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [name, value] of Object.entries(init.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      init.onUploadProgress?.({ loaded: event.loaded, total: event.total, fraction: event.loaded / event.total });
    };
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        retryAfter: parseRetryAfter(xhr.getResponseHeader("retry-after")),
        json: async () => JSON.parse(xhr.responseText),
      });
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    init.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(init.body as XMLHttpRequestBodyInit);
  });

type SubmissionAttachmentDescriptor = {
  key: string;
  file: Blob;
  fileName?: string;
};

type SubmissionAssetDescriptorValue = {
  file: unknown;
  name?: string;
  mimeType?: string;
  alt?: string;
};

type RuntimeSubmissionDefinition = {
  fields: Record<string, FieldDefinition>;
};

function normalizeRuntimeSchema(
  schema: AtMyAppClientOptions["schema"]
): SchemaDocument | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }

  if (
    "version" in schema &&
    "definitions" in schema &&
    schema.definitions &&
    typeof schema.definitions === "object"
  ) {
    return schema as SchemaDocument;
  }

  if ("definitions" in schema && schema.definitions) {
    return {
      version: 1,
      definitions: schema.definitions as Record<string, Definition>,
      description:
        typeof (schema as SchemaDocument).description === "string"
          ? (schema as SchemaDocument).description
          : undefined,
      events:
        (schema as SchemaDocument).events &&
        typeof (schema as SchemaDocument).events === "object"
          ? (schema as SchemaDocument).events
          : {},
      args:
        (schema as SchemaDocument).args &&
        typeof (schema as SchemaDocument).args === "object"
          ? (schema as SchemaDocument).args
          : {},
      mdx:
        (schema as SchemaDocument).mdx &&
        typeof (schema as SchemaDocument).mdx === "object"
          ? (schema as SchemaDocument).mdx
          : {},
      submissions:
        (schema as SchemaDocument).submissions &&
        typeof (schema as SchemaDocument).submissions === "object"
          ? (schema as SchemaDocument).submissions
          : {},
    };
  }

  return {
    version: 1,
    definitions: schema as Record<string, Definition>,
    events: {},
    args: {},
    mdx: {},
    submissions: {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.toString.call(value) === "[object Object]"
  );
}

function isBinaryLike(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer>; type?: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function isSubmissionAssetDescriptor(
  value: unknown
): value is SubmissionAssetDescriptorValue {
  return Boolean(
    isPlainObject(value) &&
      "file" in value &&
      isBinaryLike((value as SubmissionAssetDescriptorValue).file)
  );
}

function hasAnyBinaryValue(value: unknown): boolean {
  if (isBinaryLike(value) || isSubmissionAssetDescriptor(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasAnyBinaryValue(entry));
  }

  if (isPlainObject(value)) {
    return Object.values(value).some((entry) => hasAnyBinaryValue(entry));
  }

  return false;
}

function formatPath(path: Array<string | number>): string {
  return path.reduce<string>((result, segment, index) => {
    if (typeof segment === "number") {
      return `${result}[${segment}]`;
    }
    if (index === 0) {
      return segment;
    }
    return `${result}.${segment}`;
  }, "");
}

function toAttachmentRef(
  input: { mimeType?: string; name?: string; alt?: string }
) {
  const base = {
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(typeof input.mimeType === "string" ? { mimeType: input.mimeType } : {}),
  };

  if ("alt" in input && typeof input.alt === "string") {
    return {
      ...base,
      alt: input.alt,
    };
  }

  return base;
}

async function toBlob(
  value: { arrayBuffer(): Promise<ArrayBuffer>; type?: string },
  mimeType?: string
): Promise<Blob> {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    if (mimeType && value.type !== mimeType) {
      return new Blob([await value.arrayBuffer()], { type: mimeType });
    }
    return value;
  }

  const content = await value.arrayBuffer();
  return new Blob([content], {
    type: mimeType ?? value.type ?? "application/octet-stream",
  });
}

async function serializeSubmissionPayload(
  input: Record<string, unknown>
): Promise<{ data: Record<string, unknown>; attachments: SubmissionAttachmentDescriptor[] }> {
  const attachments: SubmissionAttachmentDescriptor[] = [];

  async function walk(
    value: unknown,
    path: Array<string | number>
  ): Promise<unknown> {
    if (isSubmissionAssetDescriptor(value)) {
      const blob = await toBlob(value.file as { arrayBuffer(): Promise<ArrayBuffer>; type?: string }, value.mimeType);
      attachments.push({
        key: formatPath(path),
        file: blob,
        fileName: value.name,
      });
      return toAttachmentRef({
        name: value.name,
        mimeType: value.mimeType ?? (value.file as { type?: string }).type,
        alt: value.alt,
      });
    }

    if (isBinaryLike(value)) {
      const blob = await toBlob(value);
      const possibleNamedValue = value as { name?: unknown };
      const name =
        typeof possibleNamedValue.name === "string"
          ? possibleNamedValue.name
          : undefined;
      attachments.push({
        key: formatPath(path),
        file: blob,
        fileName: name,
      });
      return toAttachmentRef({
        name,
        mimeType: value.type,
      });
    }

    if (Array.isArray(value)) {
      const treatAsAttachmentList =
        value.length > 0 &&
        value.every(
          (entry) => isBinaryLike(entry) || isSubmissionAssetDescriptor(entry)
        );

      if (treatAsAttachmentList) {
        return Promise.all(value.map((entry) => walk(entry, path)));
      }

      return Promise.all(
        value.map((entry, index) => walk(entry, [...path, index]))
      );
    }

    if (isPlainObject(value)) {
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        next[key] = await walk(entry, [...path, key]);
      }
      return next;
    }

    return value;
  }

  const data = (await walk(input, [])) as Record<string, unknown>;
  return { data, attachments };
}

function submissionUsesFiles(field: FieldDefinition): boolean {
  if (field.kind === "asset") {
    return true;
  }

  if (field.kind === "object") {
    return Object.values(field.fields).some((entry) => submissionUsesFiles(entry));
  }

  if (field.kind === "array") {
    return submissionUsesFiles(field.items);
  }

  if (field.kind === "union") {
    return field.variants.some((entry) => submissionUsesFiles(entry));
  }

  return false;
}

function inferEncType(
  submission: RuntimeSubmissionDefinition | undefined
): SubmissionFormEncType {
  if (!submission) {
    return "multipart/form-data";
  }

  return Object.values(submission.fields).some((field) => submissionUsesFiles(field))
    ? "multipart/form-data"
    : "application/x-www-form-urlencoded";
}

function toSubmissionStatus(record: SubmissionTypeRecord | null): SubmissionTypeStatus | null {
  if (!record) {
    return null;
  }

  const captcha = record.captcha ?? null;
  return {
    type: record.type,
    acceptingResponses:
      record.accepting_responses === null ||
      record.accepting_responses === undefined
        ? true
        : record.accepting_responses,
    requiresCaptcha: Boolean(captcha ?? record.requires_captcha),
    captchaProvider: captcha?.provider ?? record.captcha_provider ?? null,
    captcha,
    honeypot: record.honeypot !== false,
    formUrl: record.form_url ?? record.static_form_url ?? null,
  };
}

function resolveReturnToUrl(returnTo: string): string {
  const trimmed = returnTo.trim();
  if (!trimmed) {
    throw new Error("Submission form returnTo cannot be empty");
  }

  if (trimmed.startsWith("/")) {
    const runtimeLocation =
      typeof globalThis !== "undefined" &&
      "location" in globalThis &&
      globalThis.location &&
      typeof globalThis.location.origin === "string"
        ? globalThis.location
        : null;

    if (!runtimeLocation?.origin) {
      throw new Error(
        'Submission form returnTo paths like "/thank-you" require a browser-like runtime with location.origin'
      );
    }

    return new URL(trimmed, runtimeLocation.origin).toString();
  }

  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Submission form returnTo must use http or https");
  }

  return url.toString();
}

function withReturnTo(
  action: string,
  options?: SubmissionFormOptions
): string {
  const returnTo = options?.returnTo?.trim();
  if (!returnTo) {
    return action;
  }

  const url = new URL(action);
  url.searchParams.set("returnTo", resolveReturnToUrl(returnTo));
  return url.toString();
}

export const createSubmissionsClient = <TSchema = unknown>(
  clientOptions: AtMyAppClientOptions
): SubmissionsClient<TSchema> => {
  const submissionsUrl = `${clientOptions.baseUrl}/submissions`;
  const fetchImpl = clientOptions.customFetch ?? fetch;
  const schemaDocument = normalizeRuntimeSchema(clientOptions.schema);
  const compiledSchema = schemaDocument ? compileSchema(schemaDocument) : null;
  const compiledSubmissions =
    ((compiledSchema as { submissions?: Record<string, RuntimeSubmissionDefinition> } | null)
      ?.submissions) ?? {};

  const request = async <T>(
    path: string,
    init?: RequestInit
  ): Promise<T> => {
    const response = await fetchImpl(`${submissionsUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${clientOptions.apiKey}`,
        ...(init?.headers ?? {}),
      },
    });

    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

    if (!response.ok || !payload?.success) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new SubmissionError(
        payload?.error || `Submissions request failed with status ${response.status}`,
        {
          code: payload?.code ?? (response.ok ? "unknown" : `http_${response.status}`),
          status: response.status,
          fields: payload?.fields,
          retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        }
      );
    }

    return payload.data;
  };

  // One page render often asks for status and form params of the same type;
  // share a single /types request between them.
  let typesCache: { at: number; records: Promise<SubmissionTypeRecord[]> } | null = null;
  const loadTypes = () => {
    if (typesCache && Date.now() - typesCache.at < TYPES_CACHE_MS) return typesCache.records;
    const records = request<SubmissionTypeRecord[]>("/types", { method: "GET" });
    typesCache = { at: Date.now(), records };
    records.catch(() => {
      typesCache = null;
    });
    return records;
  };

  async function getTypeStatus(submission: string): Promise<SubmissionTypeStatus | null> {
    const records = await loadTypes();
    const match = records.find((entry) => entry.type === submission) ?? null;
    return toSubmissionStatus(match);
  }

  async function isAcceptingResponses(submission: string): Promise<boolean> {
    const status = await getTypeStatus(submission);
    return status?.acceptingResponses ?? false;
  }

  async function getFormUrl(
    submission: string,
    options?: SubmissionFormOptions
  ): Promise<string> {
    // The address is stable; reading it never creates or rotates anything.
    const status = await getTypeStatus(submission);
    if (!status) {
      throw new Error(`Submission type "${submission}" was not found`);
    }
    if (!status.formUrl) {
      throw new Error(`Submission "${submission}" does not have a public form URL`);
    }

    return withReturnTo(status.formUrl, options);
  }

  async function getFormParams(
    submission: string,
    options?: SubmissionFormOptions
  ): Promise<SubmissionFormParams> {
    const action = await getFormUrl(submission, options);
    const encType = inferEncType(compiledSubmissions[submission]);

    return {
      action,
      method: "POST",
      encType,
    };
  }

  const failure = (
    code: SubmissionErrorCode,
    message: string,
    extra: { status?: number; fields?: SubmissionFieldErrors; retryAfter?: number } = {}
  ): SubmissionResult => ({
    ok: false,
    error: new SubmissionError(message, { code, status: extra.status ?? 0, fields: extra.fields, retryAfter: extra.retryAfter }),
  });

  function validate(
    submission: string,
    data: Record<string, unknown> | FormData
  ): SubmissionValidationResult {
    const definition = compiledSubmissions[submission];
    if (!definition) return { ok: true, checked: false };
    const values = data instanceof FormData ? formDataToObject(data) : data;
    const fields = validateSubmissionData(values, definition.fields);
    return Object.keys(fields).length ? { ok: false, checked: true, fields } : { ok: true, checked: true };
  }

  /** Builds the request body once, so retries resend exactly the same submission. */
  async function encode(
    data: Record<string, unknown> | FormData,
    captchaToken: string | undefined
  ): Promise<{ body: BodyInit; contentType?: string }> {
    if (data instanceof FormData) {
      // Copy so the caller's FormData is left untouched.
      let body = data;
      if (captchaToken) {
        body = new FormData();
        data.forEach((value, key) => body.append(key, value));
        body.set(CAPTCHA_TOKEN_FIELD, captchaToken);
      }
      return { body };
    }
    if (hasAnyBinaryValue(data)) {
      const serialized = await serializeSubmissionPayload(data);
      const formData = new FormData();
      formData.set("data", JSON.stringify(serialized.data));
      if (captchaToken) formData.set(CAPTCHA_TOKEN_FIELD, captchaToken);
      for (const attachment of serialized.attachments) {
        if (attachment.fileName) formData.append(attachment.key, attachment.file, attachment.fileName);
        else formData.append(attachment.key, attachment.file);
      }
      return { body: formData };
    }
    return {
      body: JSON.stringify(captchaToken ? { ...data, [CAPTCHA_TOKEN_FIELD]: captchaToken } : data),
      contentType: "application/json",
    };
  }

  async function submit(
    submission: string,
    data: Record<string, unknown> | FormData,
    options: SubmissionSubmitOptions = {}
  ): Promise<SubmissionResult> {
    if (options.validate !== false) {
      const checked = validate(submission, data);
      if (!checked.ok)
        return failure("validation_failed", "Some fields are missing or invalid.", { fields: checked.fields });
    }

    const { body, contentType } = await encode(data, options.captchaToken);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${clientOptions.apiKey}`,
      // Every attempt carries the same key, so the service stores it once.
      "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey(),
      ...(options.test ? { "X-AMA-Test": "1" } : {}),
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
    const transport =
      options.onUploadProgress && typeof XMLHttpRequest !== "undefined" ? xhrTransport : fetchTransport(fetchImpl);
    const url = `${submissionsUrl}/${encodeURIComponent(submission)}`;
    const attempts = 1 + (options.retry === false ? 0 : Math.max(0, options.retry ?? DEFAULT_RETRIES));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const last = attempt === attempts - 1;
      let response: TransportResponse;
      try {
        response = await transport(url, {
          headers,
          body,
          signal: options.signal,
          onUploadProgress: options.onUploadProgress,
        });
      } catch (error) {
        if (isAbort(error) || options.signal?.aborted) return failure("aborted", "The submission was cancelled.");
        if (last)
          return failure("network_error", "The submission couldn’t be sent. Check the connection and try again.");
        try {
          await wait(RETRY_DELAYS_MS[attempt] ?? 3000, options.signal);
        } catch {
          return failure("aborted", "The submission was cancelled.");
        }
        continue;
      }

      const payload = (await response.json().catch(() => null)) as
        | (ApiEnvelope<{ submissionId: string; duplicate?: boolean; report?: unknown }> & { report?: unknown })
        | null;
      if (response.ok && payload?.success && payload.data) {
        return { ok: true, ...(payload.data as Omit<Extract<SubmissionResult, { ok: true }>, "ok">) };
      }

      const code = payload?.code ?? (response.status === 0 ? "network_error" : `http_${response.status}`);
      // Only brief outages are worth retrying automatically; refusals are final.
      const transient = code === "try_again" || response.status === 502 || response.status === 504;
      if (transient && !last) {
        try {
          await wait(
            Math.min(MAX_RETRY_WAIT_MS, (response.retryAfter ?? 0) * 1000 || RETRY_DELAYS_MS[attempt] || 3000),
            options.signal
          );
        } catch {
          return failure("aborted", "The submission was cancelled.");
        }
        continue;
      }
      const result = failure(code, payload?.error || `The submission failed with status ${response.status}.`, {
        status: response.status,
        fields: payload?.fields,
        retryAfter: response.retryAfter,
      });
      if (!result.ok && payload?.report)
        return { ...result, report: payload.report as Extract<SubmissionResult, { ok: false }>["report"] };
      return result;
    }
    return failure("network_error", "The submission couldn’t be sent. Check the connection and try again.");
  }

  return {
    submit,
    validate,
    getFormUrl,
    getFormParams,
    isAcceptingResponses,
    getTypeStatus,
  };
};
