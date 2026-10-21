/** Stable reasons a submission is refused. Mirrors the submissions service. */
export type SubmissionErrorCode =
  | "invalid_body"
  | "unsupported_content_type"
  | "payload_too_large"
  | "file_too_large"
  | "too_many_files"
  | "file_type_not_allowed"
  | "empty_submission"
  | "too_many_fields"
  | "too_deep"
  | "field_too_long"
  | "validation_failed"
  | "not_accepting"
  | "form_not_found"
  | "origin_not_allowed"
  | "rate_limited"
  | "captcha_missing"
  | "captcha_invalid"
  | "captcha_expired"
  | "captcha_duplicate"
  | "captcha_hostname"
  | "captcha_low_score"
  | "captcha_unavailable"
  | "captcha_not_configured"
  | "unauthorized"
  | "try_again"
  /** The request never got an answer, even after retrying. */
  | "network_error"
  /** The caller's AbortSignal fired. */
  | "aborted"
  | (string & {});

/** Per-field problems, e.g. "required", "invalid_format", "max_length". */
export type SubmissionFieldErrorCode =
  | "required"
  | "invalid_type"
  | "invalid_integer"
  | "invalid_date"
  | "invalid_format"
  | "invalid_enum"
  | "minimum"
  | "maximum"
  | "min_length"
  | "max_length"
  | "pattern"
  | "min_items"
  | "max_items"
  | "unique_items"
  | "unexpected_property"
  | (string & {});

/** Field path → problem. Paths are field names, or dotted for nested fields. */
export type SubmissionFieldErrors<Fields extends string = string> = Partial<
  Record<Fields | (string & {}), SubmissionFieldErrorCode>
>;

/**
 * Why a submission didn't go through. `submit` returns it as a value
 * (`result.error`); it is also an Error, so `throw result.error` works.
 */
export class SubmissionError<Fields extends string = string> extends Error {
  readonly code: SubmissionErrorCode;
  /** HTTP status, or 0 when no response arrived (network, abort, client-side validation). */
  readonly status: number;
  readonly fields?: SubmissionFieldErrors<Fields>;
  /** Seconds to wait before trying again (rate limits and outages). */
  readonly retryAfter?: number;

  constructor(
    message: string,
    options: {
      code: SubmissionErrorCode;
      status: number;
      fields?: SubmissionFieldErrors<Fields>;
      retryAfter?: number;
    }
  ) {
    super(message);
    this.name = "SubmissionError";
    this.code = options.code;
    this.status = options.status;
    this.fields = options.fields;
    this.retryAfter = options.retryAfter;
  }

  /** Sending the same submission again may succeed (network trouble, outages, rate limits). */
  get retryable(): boolean {
    return (
      this.code === "network_error" ||
      this.code === "try_again" ||
      this.code === "rate_limited" ||
      this.code === "captcha_unavailable" ||
      this.status >= 500
    );
  }
}
