/**
 * `@atmyapp/core/forms`: progressive enhancement for plain HTML forms that
 * post to an AtMyApp form address. No client, API key or framework needed;
 * the form keeps working without JavaScript.
 *
 *   import { enhanceSubmissionForm } from "@atmyapp/core/forms";
 *   enhanceSubmissionForm(document.querySelector("form")!, { captcha });
 */
import {
  CAPTCHA_WIDGETS,
  SUBMISSION_HONEYPOT_FIELD,
  SUBMISSION_RENDERED_AT_FIELD,
  captchaWidget,
} from "../client/captchaWidget";
import type { SubmissionCaptcha } from "../client/clientTypes";
import {
  SubmissionError,
  type SubmissionErrorCode,
  type SubmissionFieldErrors,
} from "../client/submissionError";

export { SubmissionError };
export type { SubmissionErrorCode, SubmissionFieldErrors };

export interface SubmissionFormMessages {
  sending: string;
  success: string;
  /** Shown when the request got no answer. */
  network: string;
  /** Lead-in before the list of field problems. */
  fields: string;
  /** Per field error code, e.g. `{ required: "This field is required." }`. */
  fieldCodes: Partial<Record<string, string>>;
}

export interface EnhanceSubmissionFormOptions {
  /**
   * The form's captcha, e.g. `(await ama.submissions.getTypeStatus("contact"))?.captcha`.
   * Its widget and script are added unless the form already contains one.
   */
  captcha?: SubmissionCaptcha | null;
  /** Add the hidden spam-trap field if the form has none (default true). */
  honeypot?: boolean;
  messages?: Partial<SubmissionFormMessages>;
  /** Called after the submission is stored. Return false to skip the default success handling. */
  onSuccess?: (result: { submissionId: string; duplicate?: boolean }) => void | boolean;
  onError?: (error: SubmissionError) => void;
}

const DEFAULT_MESSAGES: SubmissionFormMessages = {
  sending: "Sending…",
  success: "Thank you. Your message was sent.",
  network: "Your message could not be sent. Check your connection and try again.",
  fields: "Please check:",
  fieldCodes: {
    required: "This field is required.",
    invalid_format: "Check the format.",
    invalid_type: "Check this value.",
    invalid_enum: "Choose one of the options.",
    min_length: "This is too short.",
    max_length: "This is too long.",
    max_items: "Too many files.",
    unexpected_property: "This field isn't accepted.",
  },
};

type CaptchaGlobals = {
  grecaptcha?: {
    ready(callback: () => void): void;
    execute(siteKey: string, options: { action: string }): Promise<string>;
    reset(): void;
  };
  turnstile?: { reset(container?: Element): void };
  hcaptcha?: { reset(): void };
};

const ENHANCED = "atmyappEnhanced";

function newKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return cryptoApi?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function hiddenInput(form: HTMLFormElement, name: string, value: string) {
  const input = form.ownerDocument.createElement("input");
  input.type = "hidden";
  input.name = name;
  input.value = value;
  form.appendChild(input);
  return input;
}

function submitButtons(form: HTMLFormElement) {
  return Array.from(
    form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button:not([type]), button[type="submit"], input[type="submit"]'
    )
  );
}

function loadScript(doc: Document, src: string) {
  if (doc.querySelector(`script[src="${src}"]`)) return;
  const script = doc.createElement("script");
  script.src = src;
  script.async = true;
  script.defer = true;
  doc.head.appendChild(script);
}

/** Adds the captcha widget (or reCAPTCHA v3's hidden token field) above the submit button. */
function mountCaptcha(form: HTMLFormElement, captcha: SubmissionCaptcha) {
  const doc = form.ownerDocument;
  const existing = form.querySelector(
    `.${CAPTCHA_WIDGETS[captcha.provider].className}, [data-atmyapp-recaptcha], [name="${CAPTCHA_WIDGETS[captcha.provider].tokenField}"]`
  );
  const widget = captchaWidget(captcha);
  if (!existing) {
    let element: HTMLElement;
    if (widget.invisible) {
      element = doc.createElement("input");
      (element as HTMLInputElement).type = "hidden";
      (element as HTMLInputElement).name = widget.tokenField;
      element.dataset.atmyappRecaptcha = widget.siteKey;
    } else {
      element = doc.createElement("div");
      element.className = widget.className;
      element.dataset.sitekey = widget.siteKey;
    }
    const button = submitButtons(form)[0];
    if (button) button.before(element);
    else form.appendChild(element);
  }
  loadScript(doc, widget.scriptSrc);
}

function resetCaptcha(form: HTMLFormElement) {
  const globals = (form.ownerDocument.defaultView ?? globalThis) as unknown as CaptchaGlobals;
  const turnstile = form.querySelector(".cf-turnstile");
  if (turnstile && globals.turnstile) globals.turnstile.reset(turnstile);
  if (form.querySelector(".h-captcha")) globals.hcaptcha?.reset();
  if (form.querySelector(".g-recaptcha")) globals.grecaptcha?.reset();
}

/** reCAPTCHA v3 is invisible: fetch a fresh token right before sending. */
async function fillRecaptchaV3Token(form: HTMLFormElement) {
  const input = form.querySelector<HTMLInputElement>("[data-atmyapp-recaptcha]");
  const grecaptcha = ((form.ownerDocument.defaultView ?? globalThis) as unknown as CaptchaGlobals).grecaptcha;
  if (!input || !grecaptcha) return;
  input.value = await new Promise<string>((resolve, reject) =>
    grecaptcha.ready(() =>
      grecaptcha.execute(input.dataset.atmyappRecaptcha ?? "", { action: "submit" }).then(resolve, reject)
    )
  );
}

/** `address.city` is posted as `address[city]` by HTML forms. */
function fieldElement(form: HTMLFormElement, path: string): HTMLElement | null {
  const [head, ...rest] = path.split(".");
  const names = [path, rest.length ? `${head}${rest.map((part) => `[${part}]`).join("")}` : path, `${path}[]`];
  for (const name of names) {
    const item = form.elements.namedItem(name);
    if (item instanceof HTMLElement) return item;
    if (item && "length" in item && (item as RadioNodeList)[0] instanceof HTMLElement)
      return (item as RadioNodeList)[0] as HTMLElement;
  }
  return null;
}

/**
 * Submits the form with fetch and shows the outcome in place: a busy state,
 * per-field errors, captcha resets and a success message (or a redirect to
 * `returnTo`). Retrying after a lost connection reuses the idempotency key,
 * so the message is never stored twice.
 *
 * Field errors go into `[data-atmyapp-error="<field>"]` elements when the
 * form has them, otherwise into a summary in `[data-atmyapp-result]` (added
 * at the end of the form if missing). Returns a function that undoes it.
 */
export function enhanceSubmissionForm(
  form: HTMLFormElement,
  options: EnhanceSubmissionFormOptions = {}
): () => void {
  if (form.dataset[ENHANCED]) return () => undefined;
  form.dataset[ENHANCED] = "true";
  const doc = form.ownerDocument;
  const messages: SubmissionFormMessages = {
    ...DEFAULT_MESSAGES,
    ...options.messages,
    fieldCodes: { ...DEFAULT_MESSAGES.fieldCodes, ...options.messages?.fieldCodes },
  };
  const added: Element[] = [];

  if (options.honeypot !== false && !form.elements.namedItem(SUBMISSION_HONEYPOT_FIELD)) {
    const trap = doc.createElement("input");
    trap.type = "text";
    trap.name = SUBMISSION_HONEYPOT_FIELD;
    trap.tabIndex = -1;
    trap.autocomplete = "off";
    trap.setAttribute("aria-hidden", "true");
    trap.style.cssText = "position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden";
    form.appendChild(trap);
    added.push(trap);
  }
  if (!form.elements.namedItem(SUBMISSION_RENDERED_AT_FIELD))
    added.push(hiddenInput(form, SUBMISSION_RENDERED_AT_FIELD, String(Date.now())));
  if (options.captcha?.siteKey) mountCaptcha(form, options.captcha);

  let output = form.querySelector<HTMLElement>("[data-atmyapp-result]");
  if (!output) {
    output = doc.createElement("p");
    output.setAttribute("data-atmyapp-result", "");
    form.appendChild(output);
    added.push(output);
  }
  output.setAttribute("role", "status");
  output.setAttribute("aria-live", "polite");
  if (!output.id) output.id = `atmyapp-result-${newKey()}`;
  const status = output;

  let idempotencyKey: string | null = null;
  let pending = false;

  const clearFieldErrors = () => {
    form.querySelectorAll("[data-atmyapp-invalid]").forEach((element) => {
      element.removeAttribute("aria-invalid");
      element.removeAttribute("data-atmyapp-invalid");
    });
    form.querySelectorAll<HTMLElement>("[data-atmyapp-error]").forEach((element) => {
      element.textContent = "";
    });
  };

  const showFieldErrors = (fields: SubmissionFieldErrors) => {
    const summary: string[] = [];
    let first: HTMLElement | null = null;
    for (const [path, code] of Object.entries(fields)) {
      const text = messages.fieldCodes[code ?? ""] ?? messages.fieldCodes.invalid_type ?? "Check this field.";
      const element = fieldElement(form, path);
      const slot = form.querySelector<HTMLElement>(`[data-atmyapp-error="${CSS.escape(path)}"]`);
      if (element) {
        element.setAttribute("aria-invalid", "true");
        element.setAttribute("data-atmyapp-invalid", "");
        element.setAttribute("aria-describedby", slot?.id || status.id);
        first ??= element;
      }
      if (slot) {
        if (!slot.id) slot.id = `atmyapp-error-${newKey()}`;
        if (element) element.setAttribute("aria-describedby", slot.id);
        slot.textContent = text;
      } else {
        const label = (element && "labels" in element ? (element as HTMLInputElement).labels?.[0]?.textContent : "")?.trim();
        summary.push(`${label || path}: ${text}`);
      }
    }
    status.textContent = summary.length ? `${messages.fields} ${summary.join(" ")}` : "";
    first?.focus();
  };

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    // Kept until the service answers, so a retry after a lost connection is the same submission.
    idempotencyKey ??= newKey();
    const buttons = submitButtons(form);
    form.setAttribute("aria-busy", "true");
    buttons.forEach((button) => (button.disabled = true));
    clearFieldErrors();
    status.textContent = messages.sending;

    try {
      await fillRecaptchaV3Token(form);
      const target = new URL(form.action, doc.baseURI);
      const returnTo = target.searchParams.get("returnTo");
      target.searchParams.delete("returnTo");
      const response = await fetch(target.toString(), {
        method: "POST",
        body: new FormData(form, (event as SubmitEvent).submitter ?? undefined),
        headers: { Accept: "application/json", "Idempotency-Key": idempotencyKey },
      });
      const payload = (await response.json().catch(() => null)) as {
        success?: boolean;
        data?: { submissionId: string; duplicate?: boolean } | null;
        error?: unknown;
        code?: string;
        fields?: SubmissionFieldErrors;
      } | null;
      // The service answered, so the next attempt is a new submission.
      idempotencyKey = null;

      if (response.ok && payload?.success && payload.data) {
        if (options.onSuccess?.(payload.data) === false) return;
        if (returnTo) {
          doc.defaultView?.location.assign(returnTo);
          return;
        }
        status.textContent = messages.success;
        form.reset();
        resetCaptcha(form);
        return;
      }

      const code = (payload?.code ?? `http_${response.status}`) as SubmissionErrorCode;
      const error = new SubmissionError(typeof payload?.error === "string" ? payload.error : messages.network, {
        code,
        status: response.status,
        fields: payload?.fields,
      });
      if (code.startsWith("captcha_")) resetCaptcha(form);
      if (error.fields && Object.keys(error.fields).length) showFieldErrors(error.fields);
      else status.textContent = error.message;
      options.onError?.(error);
    } catch {
      status.textContent = messages.network;
      options.onError?.(new SubmissionError(messages.network, { code: "network_error", status: 0 }));
    } finally {
      pending = false;
      form.removeAttribute("aria-busy");
      buttons.forEach((button) => (button.disabled = false));
    }
  };

  form.addEventListener("submit", onSubmit);
  return () => {
    form.removeEventListener("submit", onSubmit);
    added.forEach((element) => element.remove());
    delete form.dataset[ENHANCED];
  };
}

/** Enhances every matching form in the document (default: `form[data-atmyapp-form]`). */
export function enhanceSubmissionForms(
  selector = "form[data-atmyapp-form]",
  options: EnhanceSubmissionFormOptions = {},
  root: ParentNode = document
): () => void {
  const cleanups = Array.from(root.querySelectorAll<HTMLFormElement>(selector)).map((form) =>
    enhanceSubmissionForm(form, options)
  );
  return () => cleanups.forEach((cleanup) => cleanup());
}
