import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { decodeTags, type LeafResult, type NoteKind } from "./notes.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";
import { tagDiff } from "./tags.js";

// WRITE-05: bulk tag set/delete across explicit detection, host or account
// targets, built on WRITE-00 (mutation coordinator) and WRITE-01
// (single-entity desired-state tag replace), with READ-03 tag reads as the
// pre-send state source.
//
// No catalogue version documents a vendor bulk tagging route, so each bulk
// leaf sequences one per-target full-replace PATCH through the coordinator:
// bulk-set unions the named tags onto each target's current set and
// bulk-delete subtracts them, and the per-target desired set travels as the
// same {"tags"} payload WRITE-01 sends. A bulk run never clears: both
// actions require at least one named tag, and deleting tags a target does
// not hold is a per-target no-op. RUX profiles are refused outright: no RUX
// tag write route is evidenced.

export const BULK_TAG_ACTIONS = ["bulk-set", "bulk-delete"] as const;
export type BulkTagAction = (typeof BULK_TAG_ACTIONS)[number];

// One confirmed run fans out to at most this many per-target replaces;
// split larger sets into multiple confirmed runs with their own audits.
export const MAX_BULK_TAG_TARGETS = 100;

export function bulkTagOperation(kind: NoteKind, action: BulkTagAction): string {
  return `qux.${kind}.tag.${action}`;
}

function leaf(kind: NoteKind, action: BulkTagAction): string {
  return `${kind} tag ${action}`;
}

function owner(kind: NoteKind, id: number): string {
  return `${kind} ${id}`;
}

// The single typed confirmation for the whole run names the exact target
// count and set, so a replay cannot silently retarget a confirmed run.
export function bulkTargetLabel(kind: NoteKind, ids: readonly number[]): string {
  const units = ids.map((id) => owner(kind, id)).join(", ");
  return ids.length === 1 ? `1 target: ${units}` : `${ids.length} targets: ${units}`;
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function previewHint(
  session: Session, flags: ReadonlyMap<string, string | boolean>, kind: NoteKind, action: BulkTagAction,
  ids: readonly number[],
): string {
  const config = flags.get("config");
  return `vectra-axi ${leaf(kind, action)}`
    + `${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)} --ids ${ids.join(",")}`;
}

function listHint(session: Session, flags: ReadonlyMap<string, string | boolean>, kind: NoteKind): string {
  const config = flags.get("config");
  return `vectra-axi ${kind} tag list`
    + `${typeof config === "string" ? ` --config ${shellQuote(config)}` : ""}`
    + ` --profile ${shellQuote(session.profile.name)} --id <id>`;
}

function invalid(message: string, ...suggestions: string[]): never {
  throw new AxiError(message, "VALIDATION_ERROR", suggestions);
}

// Targets come from exactly one of --ids (comma-separated) or --ids-file
// (one ID per line, `-` reads stdin). Query-selected targets are never
// accepted: every mutated ID is named up front. IDs are positive integers,
// duplicates collapse and the canonical order is ascending, so the typed
// confirmation names one deterministic set. More than MAX_BULK_TAG_TARGETS
// is refused so one confirmation cannot fan out without bound.
export function bulkTagTargets(
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
  action: BulkTagAction,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): number[] {
  const command = leaf(kind, action);
  const inline = flags.get("ids");
  const file = flags.get("ids-file");
  if (inline !== undefined && file !== undefined) {
    invalid("--ids cannot be combined with --ids-file",
      `Run \`vectra-axi ${command} --help\``);
  }
  let entries: string[];
  let source: string;
  if (typeof inline === "string") {
    entries = inline.split(",");
    source = "ids";
  } else if (typeof file === "string" && file) {
    const text = file === "-" ? readStdin() : readFileSync(file, "utf8");
    entries = text.split("\n");
    source = "ids-file";
  } else {
    invalid(`${command} requires --ids <id,...> or --ids-file <path>`,
      "Use --ids-file - to read the target IDs from stdin",
      `Run \`vectra-axi ${command} --help\``);
  }
  const seen = new Set<number>();
  for (const entry of entries) {
    const text = entry.trim();
    if (!text) continue;
    if (!/^\d+$/.test(text) || Number(text) < 1) {
      invalid(`--${source} must list positive integer IDs (found '${text}')`,
        "Example: --ids 7,8",
        `Run \`vectra-axi ${command} --help\``);
    }
    seen.add(Number(text));
  }
  if (seen.size === 0) {
    invalid(`${command} requires at least one target ID`,
      "Example: --ids 7,8",
      `Run \`vectra-axi ${command} --help\``);
  }
  if (seen.size > MAX_BULK_TAG_TARGETS) {
    invalid(`${command} accepts at most ${MAX_BULK_TAG_TARGETS} targets per run (got ${seen.size})`,
      "Split the set into multiple confirmed runs, each with its own audit trail",
      `Run \`vectra-axi ${command} --help\``);
  }
  return [...seen].sort((a, b) => a - b);
}

// The named tags come from exactly one of --tags (comma-separated) or
// --tags-file (one tag per line, `-` reads stdin), trimmed with blanks
// dropped and duplicates collapsed in first-seen order. Unlike the
// single-target replace, a bulk run never clears: both actions require at
// least one tag, so an empty file or blank --tags is rejected rather than
// wiping every target's set.
export function bulkTags(
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
  action: BulkTagAction,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): string[] {
  const command = leaf(kind, action);
  const inline = flags.get("tags");
  const file = flags.get("tags-file");
  if (inline !== undefined && file !== undefined) {
    invalid("--tags cannot be combined with --tags-file",
      `Run \`vectra-axi ${command} --help\``);
  }
  let entries: string[];
  let source: string;
  if (typeof inline === "string") {
    entries = inline.split(",");
    source = "tags";
  } else if (typeof file === "string" && file) {
    const text = file === "-" ? readStdin() : readFileSync(file, "utf8");
    entries = text.split("\n");
    source = "tags-file";
  } else {
    invalid(`${command} requires --tags <a,b> or --tags-file <path>`,
      "Use --tags-file - to read the tags from stdin",
      `Run \`vectra-axi ${command} --help\``);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const tag = entry.trim();
    if (tag && !seen.has(tag)) seen.add(tag);
  }
  if (seen.size === 0) {
    invalid(`${command} requires at least one tag in --${source}`,
      "Bulk runs never clear: use the single-target `tag set` with an empty file to clear one owner's tags",
      `Run \`vectra-axi ${command} --help\``);
  }
  return [...seen];
}

function sortedEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((tag, index) => tag === b[index]);
}

// bulk-set unions the named tags onto the current set, preserving current
// order and appending new tags in given order; bulk-delete subtracts the
// named tags, preserving current order.
function desiredFor(current: readonly string[], tags: readonly string[], action: BulkTagAction): string[] {
  if (action === "bulk-set") {
    const have = new Set(current);
    return [...current, ...tags.filter((tag) => !have.has(tag))];
  }
  const drop = new Set(tags);
  return current.filter((tag) => !drop.has(tag));
}

async function readTags(session: Session, kind: NoteKind, id: number): Promise<string[]> {
  const { body } = await session.request(`qux.${kind}.tag.list`, { pathParams: { id } });
  return decodeTags(body);
}

function definitionFor(
  session: Session, kind: NoteKind, action: BulkTagAction, id: number, desired: readonly string[],
): MutationDefinition {
  return {
    operation: bulkTagOperation(kind, action),
    method: "PATCH",
    path: `/api/v${session.profile.apiVersion}/tagging/${kind}/${id}`,
    effect: "write",
    // The bulk run enforces its own single confirmation naming the exact
    // target count and set before the loop; per-target coordinator
    // confirmation would need one flag per target and cannot name the set.
    requiresConfirmation: false,
    target: owner(kind, id),
    payload: { tags: desired },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof AxiError) return error.message;
  return error instanceof Error && error.message ? error.message : "Unknown bulk tag error";
}

export type BulkTagTargetResult =
  | { id: number; outcome: "applied"; added: string[]; removed: string[]; tags: string[]; audit: string }
  | { id: number; outcome: "noop" }
  | { id: number; outcome: "failed"; error: string; audit: string }
  | { id: number; outcome: "unknown"; error: string; audit: string }
  | { id: number; outcome: "refused"; error: string };

export async function runTagBulk(
  session: Session,
  coordinator: MutationCoordinator,
  flags: ReadonlyMap<string, string | boolean>,
  kind: NoteKind,
  action: BulkTagAction,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): Promise<LeafResult> {
  const command = leaf(kind, action);
  if (flags.has("execute") && flags.has("dry-run")) {
    throw new AxiError("--dry-run cannot be combined with --execute", "VALIDATION_ERROR", [
      "Omit --execute to preview the mutation without sending it",
    ]);
  }
  const ids = bulkTagTargets(flags, kind, action, readStdin);
  const tags = bulkTags(flags, kind, action, readStdin);
  // No vendor bulk tagging route is evidenced on any version, so bulk runs
  // sequence per-target PATCH replaces through the QUX tagging route and
  // refuse any other generation outright, before any read or send.
  if (session.profile.kind !== "qux") {
    throw new AxiError(
      `blocked: ${command} is not supported on ${session.profile.kind === "rux" ? "RUX v3.4" : session.profile.kind} (profile '${session.profile.name}'): no evidenced tag write route on this version`,
      "OPERATION_BLOCKED",
      ["Use a QUX v2.5 profile for bulk tag changes",
        "RUX tag writes have no evidenced route; see the capability inventory"],
    );
  }
  const profile = session.profile.name;
  const operation = bulkTagOperation(kind, action);
  const targets = bulkTargetLabel(kind, ids);
  // The preview pass reads every target through the READ-03 route and
  // passes each per-target definition through the coordinator gates, so
  // forced read-only, hand opt-in and configured scope apply to the whole
  // run before confirmation. A denied or malformed read aborts the run
  // before anything is sent rather than mutating off incomplete reads.
  const previewed: { id: number; current: string[]; desired: string[] }[] = [];
  for (const id of ids) {
    const current = await readTags(session, kind, id);
    const desired = desiredFor(current, tags, action);
    coordinator.preview(definitionFor(session, kind, action, id, desired));
    previewed.push({ id, current, desired });
  }
  if (!flags.has("execute")) {
    const changes = previewed.map(({ id, current, desired }) => {
      const { added, removed } = tagDiff(current, desired);
      return {
        id,
        current: current.length === 0 ? `0 tags found for ${owner(kind, id)}` : [...current],
        desired: [...desired],
        added: added.length === 0 ? "no tags to add" : added,
        removed: removed.length === 0 ? "no tags to remove" : removed,
      };
    });
    const steady = previewed.every(({ current, desired }) => sortedEqual(current, desired));
    const verb = action === "bulk-set" ? "present on" : "absent from";
    return { failed: false, output: {
      profile,
      type: kind,
      operation,
      action,
      tags: [...tags],
      targets,
      count: ids.length,
      changes,
      ...(steady
        ? { state: `tags already ${verb} ${targets} (no-op)` }
        : { help: [`Re-run with --execute --confirm '${targets}' to ${action} ${tags.length === 1 ? "tag" : "tags"} ${tags.map((tag) => `'${tag}'`).join(", ")} for ${targets}`] }),
    } };
  }
  // The single typed confirmation names the exact target count and set; a
  // missing or mismatched value sends nothing and journals nothing.
  const confirm = flags.get("confirm");
  if (confirm === undefined) {
    throw new AxiError(
      `blocked: ${command} needs --confirm '${targets}' (profile '${profile}')`,
      "CONFIRM_REQUIRED",
      [`Re-run with --confirm '${targets}'`],
    );
  }
  if (confirm !== targets) {
    throw new AxiError(
      `blocked: --confirm '${confirm}' does not match '${targets}' (profile '${profile}')`,
      "CONFIRM_MISMATCH",
      [`Re-run with --confirm '${targets}'`],
    );
  }
  // Each confirmed target sends at most once through the coordinator with
  // its own intent/outcome audit. A refused or failed target is recorded
  // and the loop continues, so one moved target cannot block the confirmed
  // rest; the report never claims success for unconfirmed targets.
  const hint = previewHint(session, flags, kind, action, ids);
  const results: BulkTagTargetResult[] = [];
  for (const { id, current, desired } of previewed) {
    const target = owner(kind, id);
    const { added, removed } = tagDiff(current, desired);
    let previewedRead = false;
    const readState = async (): Promise<string[]> => {
      if (!previewedRead) {
        previewedRead = true;
        return current;
      }
      const fresh = await readTags(session, kind, id);
      if (!sortedEqual(current, fresh) && !sortedEqual(fresh, desired)) {
        throw new AxiError(
          `blocked: tags for ${target} changed since the preview; re-run to preview the new state`,
          "VERSION_CONFLICT",
          [`Re-run \`${hint}\` with the same tags and without --execute to preview the current tags`],
        );
      }
      return fresh;
    };
    try {
      const result = await coordinator.execute(definitionFor(session, kind, action, id, desired), {
        execute: true,
        readState,
        isNoop: (seen: unknown) => Array.isArray(seen) && sortedEqual(seen, desired),
      });
      if (result.kind === "noop") {
        results.push({ id, outcome: "noop" });
      } else if (result.kind === "success") {
        results.push({ id, outcome: "applied", added, removed, tags: [...desired], audit: result.auditId });
      } else if (result.kind === "failed") {
        results.push({ id, outcome: "failed",
          error: `tag ${action} for ${target} was rejected with status ${result.status}`, audit: result.auditId });
      } else if (result.kind === "unknown") {
        results.push({ id, outcome: "unknown", error: result.guidance, audit: result.auditId });
      } else {
        throw new Error(`Unreachable bulk tag result for ${target}: dry runs never execute`);
      }
    } catch (error) {
      results.push({ id, outcome: "refused", error: errorMessage(error) });
    }
  }
  const count = (outcome: BulkTagTargetResult["outcome"]): number =>
    results.filter((result) => result.outcome === outcome).length;
  const troubled = results.filter((result) =>
    result.outcome === "failed" || result.outcome === "unknown" || result.outcome === "refused");
  return { failed: troubled.length > 0, output: {
    profile,
    type: kind,
    operation,
    action,
    tags: [...tags],
    targets,
    count: ids.length,
    results,
    summary: `${count("applied")} applied, ${count("noop")} unchanged,`
      + ` ${count("failed")} failed, ${count("unknown")} unknown, ${count("refused")} refused of ${ids.length} targets`,
    ...(troubled.length > 0 ? { help: [
      `Read back each unconfirmed target with \`${listHint(session, flags, kind)}\` before doing anything else; never replay an unknown outcome`,
    ] } : {}),
  } };
}
