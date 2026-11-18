import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ApiClient } from "./api";
import type { UploadSource, ValueRef } from "./compile";
import { CliError, EXIT } from "./errors";
import { sha256Hex } from "./fingerprint";
import type { ContentStore } from "./store";

const legacyPartSize = 5 * 1024 * 1024;
const cliPartSize = 8 * 1024 * 1024;
const inlineLimit = 1024 * 1024;
const intentSchema = z.object({
  intentId: z.string().min(1),
  multipart: z.boolean(),
  partSize: z.int().min(legacyPartSize).max(cliPartSize).optional(),
  expectedSize: z.int(),
});
type Intent = z.infer<typeof intentSchema>;
type Scope = { kind: "named"; branch: "main"; sessionId: string };
export type UploadProgress = { intent: Intent; sent: number };

export async function saveUpload(input: {
  api: ApiClient;
  store: ContentStore;
  scope: Scope;
  operationId: string;
  source: UploadSource;
  progress?: UploadProgress;
  checkpoint: (progress: UploadProgress) => void;
}): Promise<ValueRef> {
  const { api, scope, source, operationId } = input;
  const readBytes = () => {
    const data =
      source.content === undefined
        ? readFileSync(input.store.objectPath(source.sha256))
        : Buffer.from(source.content, "utf8");
    if (data.length !== source.size || sha256Hex(data) !== source.sha256)
      throw new CliError("asset_changed", "The saved upload does not match the planned bytes.", {
        exitCode: EXIT.conflict,
      });
    return data;
  };
  const check = (value: ValueRef | null) => {
    if (!value?.valueId || value.sha256 !== source.sha256 || value.size !== source.size)
      throw new CliError("invalid_response", "The staged value did not match the local bytes.");
    return value;
  };
  if (source.size <= inlineLimit) {
    return check(
      await api.json<ValueRef>("POST", "staging/values/inline", {
        body: {
          scope,
          operationId,
          mimeType: source.mimeType,
          content: source.content ?? readBytes().toString("base64"),
          encoding: source.content === undefined ? "base64" : "utf-8",
        },
      }),
    );
  }

  let progress = input.progress;
  if (!progress) {
    const response = await api.json("POST", "staging/uploads", {
      body: {
        scope,
        expectedSize: source.size,
        mimeType: source.mimeType,
        partSize: cliPartSize,
      },
    });
    const intent = intentSchema.safeParse(response);
    if (!intent.success || intent.data.expectedSize !== source.size)
      throw new CliError("invalid_response", "The server returned an invalid upload intent.");
    progress = { intent: intent.data, sent: 0 };
    input.checkpoint(progress);
  }
  const { intent } = progress;
  const chunk = intent.multipart ? (intent.partSize ?? legacyPartSize) : source.size;
  const parts = Math.ceil(source.size / chunk);
  const route = "staging/uploads/" + encodeURIComponent(intent.intentId);
  if (progress.sent < parts) {
    const bytes = readBytes();
    for (let index = progress.sent; index < parts; index++) {
      const target = intent.multipart ? route + "/parts/" + (index + 1) : route;
      await api.upload(target, bytes.subarray(index * chunk, Math.min(bytes.length, (index + 1) * chunk)), scope);
      input.checkpoint({ intent, sent: index + 1 });
    }
  }
  return check(await api.json<ValueRef>("POST", route + "/finalize", { body: { scope, operationId } }));
}
