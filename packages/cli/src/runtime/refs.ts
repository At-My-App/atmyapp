import { CliError, EXIT } from "./errors";

/**
 * One way to name content in every command (AgenticCliPlan.md §4):
 *
 *   doc:home            document by definition name (doc:home.json by path)
 *   coll:posts          a collection
 *   entry:posts/8f2a    one entry
 *   file:files/a.pdf    a file at a path
 *   public:logo.png     a public asset
 *   …@de                a locale:  doc:home@de
 *   …#/hero/title       a JSON pointer into the value
 *
 * The kinds and identities match staging item keys (`file:<path>`,
 * `entry:<collection>:<id>`), so `toItemKey` is a lossless step.
 */

export type RefKind = "doc" | "coll" | "entry" | "file" | "public";

export interface ContentRef {
  kind: RefKind;
  /** doc: name or path · coll: collection · entry: collection · file/public: path */
  name: string;
  /** entry only */
  entryId?: string;
  locale?: string;
  /** RFC 6901 pointer, "" for the whole value. */
  pointer?: string;
}

const KINDS: RefKind[] = ["doc", "coll", "entry", "file", "public"];
const LOCALE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function refError(input: string, why: string): CliError {
  return new CliError("invalid_ref", `Invalid content reference '${input}': ${why}`, {
    exitCode: EXIT.usage,
    fix: "Use doc:<name>, coll:<collection>, entry:<collection>/<id>, file:<path> or public:<path>, optionally with @<locale> and #/<pointer>.",
  });
}

/** Canonical BCP 47 form (`en-us` → `en-US`), or an error for an invalid tag. */
export function canonicalLocale(locale: string): string {
  try {
    const [canonical] = Intl.getCanonicalLocales(locale.trim());
    if (canonical) return canonical;
  } catch {
    // fall through
  }
  throw new CliError("invalid_locale", `'${locale}' is not a valid locale (BCP 47, e.g. de or pt-BR).`, {
    exitCode: EXIT.usage,
  });
}

export function parseRef(input: string): ContentRef {
  const raw = input.trim();
  const colon = raw.indexOf(":");
  if (colon <= 0) throw refError(input, "it needs a kind prefix");
  const kind = raw.slice(0, colon) as RefKind;
  if (!KINDS.includes(kind)) throw refError(input, `unknown kind '${raw.slice(0, colon)}'`);
  let rest = raw.slice(colon + 1);

  let pointer: string | undefined;
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    pointer = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    if (pointer !== "" && !pointer.startsWith("/")) throw refError(input, "a pointer starts with '/'");
  }

  let locale: string | undefined;
  const at = rest.lastIndexOf("@");
  // Only a language tag counts, so paths such as logo@2x.png stay paths.
  if (at !== -1 && LOCALE_TAG.test(rest.slice(at + 1))) {
    locale = canonicalLocale(rest.slice(at + 1));
    rest = rest.slice(0, at);
  }

  rest = rest.replace(/^\/+/, "");
  if (!rest) throw refError(input, "the name is empty");

  if (kind === "entry") {
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) throw refError(input, "use entry:<collection>/<id>");
    return { kind, name: rest.slice(0, slash), entryId: rest.slice(slash + 1), locale, pointer };
  }
  if (kind === "coll" && rest.includes("/")) throw refError(input, "a collection name has no '/'");
  return { kind, name: rest, locale, pointer };
}

export function formatRef(ref: ContentRef): string {
  const base = ref.kind === "entry" ? `entry:${ref.name}/${ref.entryId}` : `${ref.kind}:${ref.name}`;
  return `${base}${ref.locale ? `@${ref.locale}` : ""}${ref.pointer !== undefined ? `#${ref.pointer}` : ""}`;
}

/** The ref without locale and pointer: the stored item it names. */
export function itemRef(ref: ContentRef): ContentRef {
  return { kind: ref.kind, name: ref.name, entryId: ref.entryId };
}

/**
 * The staging item key for a resolved ref. Documents need their storage path
 * (see RemoteSchema.documentPath); collections have no item key.
 */
export function toItemKey(ref: ContentRef, documentPath?: string): string | null {
  switch (ref.kind) {
    case "entry":
      return `entry:${ref.name}:${ref.entryId}`;
    case "file":
      return `file:${ref.name}`;
    case "public":
      return `public:${ref.name}`;
    case "doc":
      return documentPath ? `file:${documentPath}` : null;
    case "coll":
      return null;
  }
}

// --- JSON pointers ------------------------------------------------------------

export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function pointerTokens(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function resolvePointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
    } else if (current && typeof current === "object" && token in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}
