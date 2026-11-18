import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { encodeStoragePath } from "../../runtime/api";
import { readEntry, readEntryBlob } from "../../runtime/content";
import { CliError, EXIT } from "../../runtime/errors";
import { parseRef, resolvePointer } from "../../runtime/refs";
import { fetchRemoteSchema } from "../../runtime/schema";
import { connect, runAction, withCommonOptions, type CommonOptions } from "../output";

/**
 * `atmyapp assets get`: downloads one image or file.
 *   file:<path>                    a file at a path
 *   entry:<collection>/<id>#/cover an asset field of an entry
 *   doc:<name>#/hero/image         an asset field of a document
 */
export function assetsCommand(): Command {
  const get = withCommonOptions(new Command("get"))
    .description("Download an image or file")
    .argument("<ref>", "file:<path>, or entry:<collection>/<id>#/<field> / doc:<name>#/<field> for an asset field")
    .requiredOption("-o, --output <file>", "Where to write it")
    .option("--force", "Overwrite an existing file", false)
    .action((input: string, options: CommonOptions & { output: string; force?: boolean }) =>
      runAction(
        options,
        async () => {
          const ref = parseRef(input);
          const output = path.resolve(options.output);
          if (fs.existsSync(output) && !options.force) {
            throw new CliError("output_exists", `${options.output} already exists.`, { exitCode: EXIT.usage, fix: "Pass --force to overwrite it." });
          }
          const { api } = connect(options);
          let bytes: Uint8Array;
          let mimeType: string;
          let source: string;
          if (ref.kind === "file") {
            const response = await api.bytes(`storage/f/${encodeStoragePath(ref.name)}`, { query: { branch: "main", skipTransformations: "true" } });
            bytes = response!.bytes;
            mimeType = response!.contentType;
            source = ref.name;
          } else if (ref.kind === "entry" || ref.kind === "doc") {
            if (!ref.pointer) {
              throw new CliError("pointer_required", "Name the asset field with #/<field>, e.g. entry:posts/8f2a#/cover.", { exitCode: EXIT.usage });
            }
            let stored: unknown;
            if (ref.kind === "entry") {
              stored = (await readEntry(api, ref.name, ref.entryId!, { view: "stored", locale: null, ref: input })).value;
            } else {
              const schema = await fetchRemoteSchema(api);
              const document = schema.resolveDocument(ref.name);
              if (!document) throw new CliError("unknown_document", `There is no document '${ref.name}'.`, { exitCode: EXIT.usage });
              const response = await api.bytes(`storage/f/${encodeStoragePath(document.path)}`, { query: { branch: "main", skipTransformations: "true" } });
              stored = JSON.parse(new TextDecoder().decode(response!.bytes));
            }
            const found = resolvePointer(stored, ref.pointer);
            const value = found.value as Record<string, unknown> | string | undefined;
            const blobId = typeof value === "string" ? value : typeof value?.__blob === "string" ? value.__blob : null;
            const assetPath = value && typeof value === "object" && typeof value.$asset === "string" ? value.$asset : null;
            if (!found.found || (!blobId && !assetPath)) {
              throw new CliError("not_an_asset", `${ref.pointer} in ${input} is not an image or file. Point at a single asset (for a gallery, add the index: /photos/0).`, {
                exitCode: EXIT.usage,
                pointer: ref.pointer,
              });
            }
            if (ref.kind === "entry" && blobId) {
              const blob = await readEntryBlob(api, ref.name, ref.entryId!, blobId);
              bytes = blob!.bytes;
              mimeType = blob!.contentType;
              source = `blob ${blobId}`;
            } else {
              const response = await api.bytes(`storage/f/${encodeStoragePath(assetPath!)}`, { query: { branch: "main", skipTransformations: "true" } });
              bytes = response!.bytes;
              mimeType = response!.contentType;
              source = assetPath!;
            }
          } else {
            throw new CliError("not_supported_yet", "Use file:, entry:…#/<field> or doc:…#/<field>.", { exitCode: EXIT.usage });
          }
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, bytes);
          return { ref: input, source, output, size: bytes.length, mimeType };
        },
        (result) => console.log(`Saved ${result.source} (${result.mimeType}, ${result.size} bytes) to ${result.output}`),
      ),
    );
  return new Command("assets").description("Download images and files").addCommand(get);
}
