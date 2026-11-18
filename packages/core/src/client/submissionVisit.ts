/** Current-tab attribution for form messages. No cookies or visitor identifiers. */
export const SUBMISSION_VISIT_FIELD = "_ama_visit";
const STORAGE_KEY = "atmyapp:visit:v1";
const IDLE_MS = 30 * 60 * 1000;
export type SubmissionVisit = {
  version: 1;
  source: string | null;
  campaign: string | null;
  medium: string | null;
  landingPage: string;
  page: string;
};
type StoredVisit = SubmissionVisit & { lastSeen: number };
const states = new WeakMap<Window, StoredVisit>();
const installed = new WeakMap<Window, Set<string>>();
const clean = (value: string | null, max = 120) => value?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || null;

function arrival(win: Window): SubmissionVisit {
  const url = new URL(win.location.href);
  const page = url.origin + url.pathname;
  const params = url.searchParams;
  const medium = clean(params.get("utm_medium"), 50);
  const utm = clean(params.get("utm_source"), 100);
  const via = params.get("via");
  let source: string | null = null;
  try {
    const ref = new URL(win.document.referrer);
    if (["http:", "https:"].includes(ref.protocol) && ref.origin !== url.origin)
      source = ref.hostname.toLowerCase().replace(/^www\./, "");
  } catch { /* Referrers are often withheld. */ }
  if (["gclid", "gbraid", "wbraid"].some((key) => params.has(key)) ||
      (utm?.toLowerCase() === "google" && /^(cpc|ppc|paid|paidsearch)$/i.test(medium || ""))) source = "ads.google.com";
  else if (utm && /^[\p{L}\p{N} _.-]+$/u.test(utm)) source = "utm:" + utm;
  else if (!source && params.has("fbclid")) source = "facebook.com";
  else if (!source && params.has("ttclid")) source = "tiktok.com";
  else if (!source && params.has("msclkid")) source = "bing.com";
  if (via && /^[a-z0-9][a-z0-9-]{0,63}$/.test(via)) source = "link:" + via;
  return { version: 1, source, campaign: clean(params.get("utm_campaign")), medium, landingPage: page, page };
}

/** Optional context only: unavailable storage or malformed URLs never break sending. */
export function getSubmissionVisit(win: Window | undefined = typeof window === "undefined" ? undefined : window): SubmissionVisit | null {
  if (!win) return null;
  try {
    if (!/^https?:$/.test(win.location.protocol) || new URL(win.location.href).searchParams.has("amaPreviewKey")) return null;
    const now = Date.now();
    let state = states.get(win);
    if (!state) {
      try {
        const saved = JSON.parse(win.sessionStorage.getItem(STORAGE_KEY) || "null") as StoredVisit | null;
        const external = win.document.referrer && new URL(win.document.referrer).origin !== win.location.origin;
        if (!external && saved?.version === 1 && Number.isFinite(saved.lastSeen) &&
            now >= saved.lastSeen && now - saved.lastSeen < IDLE_MS &&
            new URL(saved.landingPage).origin === win.location.origin) {
          // Rebuild the allowlisted shape; never forward arbitrary storage contents.
          state = { version: 1, source: clean(saved.source, 253), campaign: clean(saved.campaign), medium: clean(saved.medium, 50),
            landingPage: new URL(saved.landingPage).origin + new URL(saved.landingPage).pathname,
            page: win.location.origin + win.location.pathname, lastSeen: saved.lastSeen };
        }
      } catch { /* Memory fallback for browsers that block storage. */ }
    }
    if (!state || now < state.lastSeen || now - state.lastSeen >= IDLE_MS) state = { ...arrival(win), lastSeen: now };
    state.page = win.location.origin + win.location.pathname;
    state.lastSeen = now;
    states.set(win, state);
    try { win.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Keep only this page's context. */ }
    const { lastSeen: _lastSeen, ...context } = state;
    return context;
  } catch { return null; }
}

/** Install in the shared layout so the landing page is captured before navigation. */
export function installSubmissionVisit(options: { formOrigins?: string[] } = {}): void {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof window.addEventListener !== "function") return;
  const previous = installed.get(window);
  const origins = previous ?? new Set(["https://edge.atmyapp.com", "https://staging-edge.atmyapp.com"]);
  for (const origin of options.formOrigins || []) origins.add(origin);
  if (previous) return;
  installed.set(window, origins);
  getSubmissionVisit();
  const targets = new WeakMap<HTMLFormElement, { action: string; method: string }>();
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const button = (event as SubmitEvent).submitter;
    targets.set(form, {
      action: button?.getAttribute("formaction") ?? form.action,
      method: button?.getAttribute("formmethod") ?? form.method,
    });
  }, true);
  const allowed = (form: HTMLFormElement) => {
    try {
      const target = targets.get(form) ?? { action: form.action, method: form.method };
      const url = new URL(target.action, window.location.href);
      return target.method.toLowerCase() === "post" && origins.has(url.origin) && /^\/forms\/[^/]+\/[^/]+\/?$/.test(url.pathname);
    } catch { return false; }
  };
  document.addEventListener("formdata", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !allowed(form)) return;
    const context = getSubmissionVisit();
    if (context) (event as FormDataEvent).formData.set(SUBMISSION_VISIT_FIELD, JSON.stringify(context));
  }, true);
  for (const event of ["pageshow", "astro:page-load"]) window.addEventListener(event, () => { getSubmissionVisit(); });
  let lastTouch = 0;
  for (const event of ["pointerdown", "keydown"]) window.addEventListener(event, () => {
    if (Date.now() - lastTouch < 30_000) return;
    lastTouch = Date.now();
    getSubmissionVisit();
  }, { passive: true });
}
