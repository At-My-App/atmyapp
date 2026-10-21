import type { SubmissionCaptcha, SubmissionCaptchaProvider, SubmissionCaptchaWidget } from "./clientTypes";

/** Hidden spam-trap input. Real visitors leave it empty. */
export const SUBMISSION_HONEYPOT_FIELD = "_ama_hp";
/** Epoch milliseconds when the form was rendered; very fast submits are dropped. */
export const SUBMISSION_RENDERED_AT_FIELD = "_ama_t";

/** Field for a captcha token from a widget the site renders itself. */
export const CAPTCHA_TOKEN_FIELD = "captchaToken";

export const CAPTCHA_WIDGETS: Record<SubmissionCaptchaProvider, { className: string; tokenField: string }> = {
  turnstile: { className: "cf-turnstile", tokenField: "cf-turnstile-response" },
  recaptcha: { className: "g-recaptcha", tokenField: "g-recaptcha-response" },
  hcaptcha: { className: "h-captcha", tokenField: "h-captcha-response" },
};

/**
 * How to render the captcha a submission type requires, e.g. from
 * `(await ama.submissions.getTypeStatus("contact"))?.captcha`.
 */
export function captchaWidget(captcha: SubmissionCaptcha): SubmissionCaptchaWidget {
  const invisible = captcha.provider === "recaptcha" && captcha.version !== "v2";
  const scriptSrc =
    captcha.provider === "turnstile"
      ? "https://challenges.cloudflare.com/turnstile/v0/api.js"
      : captcha.provider === "hcaptcha"
        ? "https://js.hcaptcha.com/1/api.js"
        : invisible
          ? `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(captcha.siteKey)}`
          : "https://www.google.com/recaptcha/api.js";
  return { ...captcha, ...CAPTCHA_WIDGETS[captcha.provider], scriptSrc, invisible };
}

