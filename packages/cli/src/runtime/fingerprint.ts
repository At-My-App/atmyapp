import { createHash } from "crypto";

/**
 * The content fingerprint the server compares edit baselines with
 * (ama-shared `editBaselineDigest`): sorted keys, document assets by their
 * stable asset ID, delivered assets by blob ID, and for entries without the
 * system fields at the root. A fingerprint printed by a read can be sent back
 * as `expectedBase: { exists: true, sha256 }` on a later write.
 *
 * Keep in sync with ama-shared/src/domain/editBaselines.ts.
 */

const ENTRY_SYSTEM_FIELDS = new Set([
  "id",
  "created",
  "updated",
  "created_at",
  "updated_at",
  "createdAt",
  "updatedAt",
]);

export type FingerprintKind = "entry" | "file";

/** `ga_<base64url(path)>`, as ama-shared `stagedDocumentAssetBlobId`. */
export function documentAssetId(storagePath: string): string {
  const normalized = storagePath.trim().replace(/\\+/g, "/").replace(/^\/+/, "").replace(/\/$/, "");
  return `ga_${Buffer.from(normalized, "utf8").toString("base64url")}`;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function contentFingerprint(kind: FingerprintKind, value: unknown): string {
  const entry = kind === "entry";
  let input = value;
  if (!entry && typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      // Plain text keeps its exact bytes.
    }
  }
  const normalize = (current: unknown, root = false): unknown => {
    if (Array.isArray(current)) return current.map((item) => normalize(item));
    if (!current || typeof current !== "object") return current;
    const record = current as Record<string, unknown>;
    if (!entry && typeof record.$asset === "string") return documentAssetId(record.$asset);
    if (typeof record.blobId === "string" && typeof record.url === "string") return record.blobId;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => !(root && entry && ENTRY_SYSTEM_FIELDS.has(key)))
        .map((key) => [key, normalize(record[key])]),
    );
  };
  return sha256Hex(JSON.stringify(normalize(input, true)));
}
