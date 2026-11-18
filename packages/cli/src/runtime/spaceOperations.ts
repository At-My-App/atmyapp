import type { ApiClient } from "./api";
import { CliError, EXIT } from "./errors";
import { getNamedSession } from "./sessions";
import { currentSpace, readSpace, removeSpaceFiles, spaceNames, withSpace, type SpaceFile } from "./spaces";
import type { ContentStore } from "./store";
import { WorkingCopy, type WorkState } from "./workingCopy";

export async function listSpaces(
  store: ContentStore,
  options: { active?: string; connect?: () => ApiClient | undefined } = {},
) {
  const active = currentSpace(store, options.active);
  const manifest = store.readManifest();
  const localSpaces = spaceNames(store).map((name) => readSpace(store, name));
  const connected = manifest && localSpaces.some((space) => space.session) ? options.connect?.() : undefined;
  const api = connected?.session.projectId === manifest?.projectId ? connected : undefined;
  const keys = new Map<string, string[]>();
  const spaces = await Promise.all(
    localSpaces.map(async (space) => {
      const { name } = space;
      const items = manifest
        ? new WorkingCopy(store, name).itemStates(space).filter((item) => item.state !== "published")
        : [];
      const counts: Partial<Record<WorkState, number>> = {};
      for (const item of items) {
        counts[item.state] = (counts[item.state] ?? 0) + 1;
        keys.set(item.key, [...(keys.get(item.key) ?? []), name]);
      }
      let reviewState: string | undefined;
      let expiresAt: string | undefined;
      if (space.session && api) {
        try {
          const draft = await getNamedSession(api, space.session.sessionId);
          reviewState = draft.status === "active" ? draft.reviewState : draft.status;
          expiresAt = draft.expiresAt;
        } catch (error) {
          if (!(error instanceof CliError && ["session_expired", "network", "missing_scope"].includes(error.code)))
            throw error;
          if (error.code === "session_expired") reviewState = "expired";
        }
      }
      return {
        name,
        active: name === active,
        counts,
        session: space.session,
        reviewState,
        expiresAt,
        removable:
          Object.keys(counts).length === 0 && (!space.session || ["expired", "committed"].includes(reviewState ?? "")),
      };
    }),
  );
  return {
    active,
    spaces,
    overlaps: [...keys].filter(([, names]) => names.length > 1).map(([key, names]) => ({ key, spaces: names.sort() })),
  };
}

export async function removeSpace(
  store: ContentStore,
  name: string,
  options: {
    force?: boolean;
    dryRun?: boolean;
    connect?: () => ApiClient | undefined;
  } = {},
) {
  const check = async (space: SpaceFile) => {
    if (!options.force) {
      const manifest = store.readManifest();
      const pending =
        manifest &&
        new WorkingCopy(store, name)
          .itemStates(space)
          .some((item) => !["published", "staged", "remote-changed"].includes(item.state));
      if (pending)
        throw new CliError("space_has_edits", "This space has unpushed changes.", {
          exitCode: EXIT.confirmation,
          fix: "Push the edits or pass --force to remove the local space.",
        });
      if (space.session) {
        const api = options.connect?.();
        if (!api || api.session.projectId !== manifest?.projectId)
          throw new CliError(
            "needs_confirmation",
            "Connect to this space's project to check whether the draft is in review.",
            {
              exitCode: EXIT.confirmation,
              fix: "Connect to the project or pass --force.",
            },
          );
        try {
          const draft = await getNamedSession(api, space.session.sessionId);
          if (draft.status === "active" && draft.reviewState === "in_review")
            throw new CliError("session_in_review", "This space's draft is in review.", {
              exitCode: EXIT.session,
              fix: "Pass --force to remove the local space.",
            });
        } catch (error) {
          if (!(error instanceof CliError && error.code === "session_expired")) throw error;
        }
      }
    }
    if (!options.dryRun) removeSpaceFiles(store, name);
    return { space: name, dryRun: !!options.dryRun };
  };
  return options.dryRun ? check(readSpace(store, name)) : withSpace(store, name, check);
}
