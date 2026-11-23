# @atmyapp/core

## 0.7.0

### Minor Changes

- 03686a1: Attach cookie-free current-tab visit context to form submissions. The Astro integration captures the landing source before navigation; native forms, enhanced forms and SDK submissions preserve it without cookies, persistent visitor identifiers or raw advertising click IDs. Context expires after 30 minutes of inactivity and gracefully falls back when session storage is unavailable.
- 9be0ddb: The client reads the local copy written by `atmyapp content pull` (`.ama/content`): `clientMode: "local"` shows it, including drafts in the active space, and `"with-fallback"` falls back to its published content only. Translations and image URLs come out in the same shape as from the API. `ATMYAPP_CLIENT_MODE` overrides `clientMode`; with `@atmyapp/astro`, local mode needs no API key and the dev server reloads when the copy changes.

  Fixes local mode reading no files in a normal Node process: the file system was loaded through a global `require` that only exists in a REPL.

- e5e210b: **Breaking:** `submissions.submit` now resolves to a result instead of throwing. Success is `{ ok: true, submissionId, duplicate?, report? }`; failure is `{ ok: false, error }`, where `error` is a `SubmissionError` with a stable `code`, typed `fields`, `status`, `retryAfter` and `retryable`. Replace `try { const { submissionId } = await submit(…) } catch` with `const result = await submit(…); if (result.ok) …`. Network failures (after automatic retries) and cancellations are results too (`network_error`, `aborted`).

  `submit` generates an idempotency key when none is given and retries lost connections and brief outages with it (`retry`, default 2), so a submission is never stored twice. With a schema it checks values before sending (`validate`, default on); `submissions.validate(name, data)` runs the same checks on demand. `onUploadProgress` reports upload progress in browsers. The new `@atmyapp/core/forms` entry exports `enhanceSubmissionForm` and `enhanceSubmissionForms`: dependency-free inline submission for plain HTML forms, with field errors, captcha mounting and resets, and safe retries. `<AtMyAppForm enhance>` now uses it, and supports `data-atmyapp-error="<field>"` elements for per-field messages.

  Submissions v2. `getFormUrl` and `getFormParams` read the stable form address from the type list instead of calling the form-url endpoint, so rendering a form no longer creates or rotates a link. `getTypeStatus` adds the public captcha settings (`captcha: { provider, siteKey }`) and `honeypot`. `submit` accepts `idempotencyKey` and `test` (runs every check, keeps the submission as a 24-hour test, and returns a step `report`). The Astro `<AtMyAppForm>` renders the hidden spam-trap field and a render timestamp.

  Captcha widgets: `getTypeStatus().captcha` includes the reCAPTCHA `version`, `captchaWidget(captcha)` describes how to render any provider's widget in any framework, and `submit` accepts a `captchaToken` from a widget you render yourself. `<AtMyAppForm>` renders the configured Turnstile, reCAPTCHA (v2 or v3) or hCaptcha widget automatically (the `captcha` slot still overrides it). The `enhance` script disables the submit button while sending, marks invalid fields with `aria-invalid` and lists their errors, resets the captcha after a captcha error, and reuses an idempotency key when retrying after a network error.

### Patch Changes

- 8f60f5a: Local mode images and files now load in the browser: the Astro dev server serves `.ama/content` at `/__atmyapp/content/`, and the client returns URLs on that route (set `ATMYAPP_LOCAL_ASSET_BASE` with other frameworks) instead of `file://` URLs, which browsers refuse on web pages. `$file` values that point outside the local store are no longer turned into URLs. Incremental `content pull` now hard-links unchanged files instead of copying the whole local copy.
- 43e57cb: Edit AtMyApp content in local spaces, validate it, and submit named drafts for dashboard review. The local SDK applies space-specific file and translation deletions.
- f3f951c: Edit translations from source-checked segments or a merged local view. Share locale overlays and source history across CLI, SDK, and server workflows.
- Updated dependencies [f3f951c]
- Updated dependencies [9be0ddb]
  - @atmyapp/structure@0.6.0

## 0.6.0

### Minor Changes

- 6f364cd: Collection reads keep the server's `previewApproximate` flag: `dataWithMeta` results carry it, `onPreviewApproximate` is called (a console warning by default), and `strictPreview` turns an approximate preview into a failed request that follows `errorPolicy`. The structure package adds `pruneDeletedItemTranslations`, which drops translations of source items that were deleted, and `validateLocalizedOverlayFields`, which reports translated values for fields that are not localized (`not-localizable`).

### Patch Changes

- Updated dependencies [6f364cd]
  - @atmyapp/structure@0.5.0

## 0.5.0

### Minor Changes

- d6d295e: Add shared draft/publication validation with stable issue codes and severities, explicit nullability, creation-only normalization, stable object-list identities, strict schema checks, and a testing corpus export. Reject ambiguous identity/union normalization instead of guessing, preserve delivery keys and generated item types, include singleton references in integrity snapshots, and make website settings types reflect their optional stored fields. Publication editorial acceptance must be bound to an exact human-reviewed state by the server.

### Patch Changes

- Updated dependencies [d6d295e]
- Updated dependencies [d6d295e]
- Updated dependencies [d6d295e]
  - @atmyapp/structure@0.4.0

## 0.4.0

### Minor Changes

- fb461ae: Replace experimental Astro metadata with framework-independent Website settings. Share the schema, defaults, title and social resolution, and basic homepage structured data. Support managed image references and explicit removal. Astro uses the neutral system-config endpoint and renders server-generated browser and phone icon URLs.

  This changes the experimental configuration path and removes the framework parameter from system-config reads. Coordinate the AMA backend update and initialize Website settings; no migration is provided. Page title overrides support `titleMode="absolute"`. AI enrichment remains a subsequent feature.

### Patch Changes

- Updated dependencies [fb461ae]
  - @atmyapp/structure@0.3.0

## 0.3.0

### Minor Changes

- 0560083: Add optional, sanitized integration reports and an Astro diagnostics route helper for runtime and static websites.

### Patch Changes

- 0560083: Add static-first Astro integration, shared request-scoped clients, DEV_MODE with IS_DYNAMIC alias, preview-aware metadata defaults, safe head output, HTML submission forms and detailed Astro guides. System configuration requests now carry preview context, and all core request clients honor customFetch through the transport library's supported option. Astro integration requires Astro 5+ and Node 22.14+.

## 0.2.0

### Minor Changes

- a742a81: Add order fields and improve reference and slug handling for managed content schemas.

### Patch Changes

- Updated dependencies [a742a81]
  - @atmyapp/structure@0.2.0

## 0.1.4

### Patch Changes

- 8803c37: Move AtMyApp packages into the public monorepo release pipeline.
- Updated dependencies [8803c37]
  - @atmyapp/structure@0.1.4
