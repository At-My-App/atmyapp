import { captchaWidget, type AtMyAppClient } from "@atmyapp/core";
export async function resolveForm(
  client: Pick<AtMyAppClient, "submissions">,
  submission: string,
  options: {
    returnTo?: string;
    site?: URL;
    preview?: boolean;
    allowPreviewSubmit?: boolean;
    hasCaptcha?: boolean;
  } = {},
) {
  if (options.preview && !options.allowPreviewSubmit)
    return {
      enabled: false,
      reason: "Form submissions are disabled in previews.",
    } as const;
  const status = await client.submissions.getTypeStatus(submission);
  if (!status)
    throw new Error(`AtMyApp: submission type "${submission}" was not found.`);
  if (!status.acceptingResponses)
    return {
      enabled: false,
      reason: "This form is currently closed.",
    } as const;
  // The configured widget is rendered automatically unless the page brings
  // its own through the captcha slot.
  const captcha =
    status.captcha?.siteKey && !options.hasCaptcha
      ? captchaWidget(status.captcha)
      : null;
  if (status.requiresCaptcha && !options.hasCaptcha && !captcha)
    return {
      enabled: false,
      reason:
        "This form requires CAPTCHA. Add a captcha slot before accepting submissions.",
    } as const;
  let returnTo: string | undefined;
  if (options.returnTo) {
    const target = new URL(options.returnTo, options.site);
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      throw new Error("AtMyApp: invalid form return URL.");
    if (options.site && target.origin !== options.site.origin)
      throw new Error(
        "AtMyApp: form return URL must belong to the configured website.",
      );
    target.searchParams.delete("amaPreviewKey");
    returnTo = target.toString();
  }
  const params = await client.submissions.getFormParams(submission, {
    returnTo,
  });
  return {
    enabled: true,
    ...params,
    honeypot: status.honeypot !== false,
    captcha,
  } as const;
}
