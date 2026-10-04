import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { decodeTags, noteOwnerId, type LeafResult, type NoteKind } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

// WRITE-01: desired-state tag replace for one detection, host or account.
// The upstream contract (VAT set_*_tags on the pinned commit) is a full
// replace through PATCH /tagging/{kind}/{id} with a {"tags"} payload, so
// "make the tags exactly X" maps directly: read the current set through the
// READ-03 route, preview the added/removed diff as the dry run, and send
// only when the diff is non-empty. An empty desired set clears all tags.
// The endpoint carries no evidenced ETag contract, so the concurrency check
// is a client-side re-read: when the tags move between the preview read and
// the pre-send re-read, the send is refused instead of overwriting blindly.

function leaf(kind: NoteKind): string {
  return `${kind} tag set`;
}

function target(kind: NoteKind, id: number): string {
  return `${kind} ${id}`;
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function tagCommand(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: NoteKind, action: "list" | "set", id: number,
): string {
  const config = flags.get("config");
  return `vectra-axi ${kind} tag ${action}`
    + `${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)} --id ${id}`;
}

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

// Desired tags come from exactly one of --tags (comma-separated, so an
// empty value clears) or --tags-file (one tag per line, `-` reads stdin).
// Entries are trimmed, empties dropped and duplicates collapsed to set
// semantics in first-seen order. Tag values are otherwise passed through:
// no upstream value grammar is evidenced, so none is invented here.
export function desiredTags(
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): string[] {
  const command = leaf(kind);
  const inline = flags.get("tags");
  const file = flags.get("tags-file");
  if (inline !== undefined && file !== undefined) {
    invalid("--tags cannot be combined with --tags-file",
      `Run \`vectra-axi ${command} --help\``);
  }
  // Clearing all tags needs an empty file or empty stdin: --tags always
  // carries at least one tag, so a stray blank can never wipe a tag set.
  let entries: string[];
  if (typeof inline === "string") {
    entries = inline.split(",");
  } else if (typeof file === "string" && file) {
    const text = file === "-" ? readStdin() : readFileSync(file, "utf8");
    entries = text.split("\n");
  } else {
    invalid(`${command} requires --tags <a,b> or --tags-file <path>`,
      "Pass an empty file or empty stdin to clear all tags",
      `Run \`vectra-axi ${command} --help\``);
  }
  if (typeof inline === "string" && entries.every((entry) => !entry.trim())) {
    invalid(`${command} requires at least one tag in --tags`,
      "Pass an empty file or empty stdin to clear all tags",
      `Run \`vectra-axi ${command} --help\``);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const tag = entry.trim();
    if (tag && !seen.has(tag)) seen.add(tag);
  }
  return [...seen];
}

function sortedEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((tag, index) => tag === b[index]);
}

export function tagDiff(current: readonly string[], desired: readonly string[]): {
  added: string[]; removed: string[];
} {
  const want = new Set(desired);
  const have = new Set(current);
  return {
    added: desired.filter((tag) => !have.has(tag)),
    removed: current.filter((tag) => !want.has(tag)),
  };
}

async function readTags(session: Session, kind: NoteKind, id: number): Promise<string[]> {
  const { body } = await session.request(`qux.${kind}.tag.list`, { pathParams: { id } });
  return decodeTags(body);
}

function describeTags(kind: NoteKind, id: number, tags: readonly string[]): string | readonly string[] {
  return tags.length === 0 ? `0 tags found for ${kind} ${id}` : [...tags];
}

// Reads one detection/host/account tag replace through the WRITE-00 gate
// pipeline: hand-enabled scope, preview, --execute, durable journal
// intent/outcome and no replay all live in the coordinator. Effect is
// "write", never disruptive, so no --confirm flag exists on this leaf.
export async function runTagSet(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): Promise<LeafResult> {
  const command = leaf(kind);
  const id = noteOwnerId(flags, command, kind);
  const desired = desiredTags(flags, kind, readStdin);
  const owner = target(kind, id);
  const definition: MutationDefinition = {
    operation: `${session.profile.kind}.${kind}.tag.set`,
    method: "PATCH",
    path: `/api/v${session.profile.apiVersion}/tagging/${kind}/${id}`,
    effect: "write",
    target: owner,
    payload: { tags: desired },
  };
  // The coordinator reads once for the preview and re-reads before the
  // single send. A moved baseline that no longer matches the preview and
  // does not already equal the desired set refuses the send rather than
  // overwriting another writer's tags; the refusal is recorded as NOT_SENT.
  let baseline: string[] | undefined;
  const readState = async (): Promise<string[]> => {
    const current = await readTags(session, kind, id);
    if (baseline === undefined) {
      baseline = current;
      return current;
    }
    if (!sortedEqual(baseline, current) && !sortedEqual(current, desired)) {
      throw new AxiError(
        `blocked: tags for ${owner} changed since the preview; re-run to preview the new state`,
        "VERSION_CONFLICT",
        [`Re-run \`${tagCommand(session, flags, kind, "set", id)}\` with the same desired tags and without --execute to preview the current tags`],
      );
    }
    return current;
  };
  const result = await coordinator.execute(definition, {
    ...(flags.has("execute") ? { execute: true } : {}),
    ...(flags.has("dry-run") ? { dryRun: true } : {}),
    readState,
    isNoop: (current: unknown) => Array.isArray(current) && sortedEqual(current, desired),
  });
  const before = baseline ?? [];
  const { added, removed } = tagDiff(before, desired);
  const profile = session.profile.name;
  if (result.kind === "dry-run") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      current: describeTags(kind, id, before),
      desired: desired.length === 0 ? "(no tags: clears all tags)" : desired,
      added: added.length === 0 ? "no tags to add" : added,
      removed: removed.length === 0 ? "no tags to remove" : removed,
      ...(result.preview.noop
        ? { state: `tags already match for ${owner} (no-op)` }
        : { help: [`Re-run with --execute to replace the tags for ${owner}`] }),
    } };
  }
  if (result.kind === "noop") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      tags: `tags already match for ${owner} (no-op)`,
    } };
  }
  if (result.kind === "success") {
    return { failed: false, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      tags: desired.length === 0 ? `all tags cleared for ${owner}` : desired,
      added: added.length === 0 ? "no tags added" : added,
      removed: removed.length === 0 ? "no tags removed" : removed,
      audit: result.auditId,
    } };
  }
  if (result.kind === "failed") {
    return { failed: true, output: {
      profile,
      type: kind,
      id,
      operation: definition.operation,
      error: `tag replace for ${owner} was rejected with status ${result.status}`,
      audit: result.auditId,
      help: [`Read back \`${tagCommand(session, flags, kind, "list", id)}\` before doing anything else`],
    } };
  }
  return { failed: true, output: {
    profile,
    type: kind,
    id,
    operation: definition.operation,
    error: result.guidance,
    audit: result.auditId,
  } };
}
