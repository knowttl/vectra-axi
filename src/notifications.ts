import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { AxiError } from "axi-sdk-js";
import { z } from "zod";
import type { LeafResult } from "./notes.js";
import { containsRedactedPlaceholder, type SecretRedactor } from "./redact.js";
import type { Session } from "./session.js";
import type { MutationCoordinator, MutationDefinition } from "./writes.js";

const configSchema = z.strictObject({
  event_rules: z.record(z.string(), z.unknown()).optional(),
  destination_params: z.object({ url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)) }).catchall(z.unknown()),
});
const documentSchema = z.strictObject({
  destination_type: z.string().trim().min(1), title: z.string().trim().min(1),
  enabled: z.boolean().optional(), config: configSchema,
});
const rowSchema = documentSchema.extend({
  config: configSchema.extend({ destination_params: z.object({ url: z.string().min(1) }).catchall(z.unknown()) }),
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  date_created: z.string().optional(), created_by: z.string().nullable().optional() });
type Destination = z.infer<typeof rowSchema>;
const warning = "High risk: notification destinations redirect event data to external endpoints (egress).";

function requireRux(session: Session): void {
  if (session.profile.kind !== "rux") throw new AxiError("Notification destinations are unsupported on QUX", "UNSUPPORTED_OPERATION", [
    "Select a RUX profile for notification destination commands",
  ]);
}

function destinationId(flags: ReadonlyMap<string, string | boolean>): string {
  const id = flags.get("id");
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new AxiError(
    "--id requires a destination identifier (letters, digits, underscores or hyphens)", "VALIDATION_ERROR",
    ["Run `vectra-axi notification destination show --help`"],
  );
  return id;
}

async function readDestinations(session: Session, id?: string): Promise<Destination[]> {
  const { body } = await session.request(`rux.notification-destination.${id === undefined ? "list" : "show"}`,
    id === undefined ? {} : { pathParams: { id } });
  const parsed = id === undefined ? z.object({ destinations: z.array(rowSchema).max(24) }).safeParse(body)
    : z.object({ destination: rowSchema }).transform(({ destination }) => ({ destinations: [destination] })).safeParse(body);
  if (!parsed.success || new Set(parsed.data.destinations.map((row) => row.id)).size !== parsed.data.destinations.length
    || (id !== undefined && parsed.data.destinations[0]?.id !== id)) throw new AxiError(
    "Cannot determine notification destination state", "MALFORMED_RESPONSE", ["Read the destination before retrying"],
  );
  return parsed.data.destinations;
}

export async function runNotificationRead(
  session: Session, flags: ReadonlyMap<string, string | boolean>, action: "list" | "show",
): Promise<LeafResult> {
  requireRux(session);
  const rows = await readDestinations(session, action === "show" ? destinationId(flags) : undefined);
  return { failed: false, output: action === "show" ? { profile: session.profile.name, ...rows[0] } : {
    profile: session.profile.name, count: rows.length,
    destinations: rows.map(({ id, title, destination_type, enabled }) => ({ id, title, destination_type, enabled })),
    help: rows.length ? [`Run \`vectra-axi notification destination show --profile ${session.profile.name} --id <id>\` for detail`]
      : ["No notification destinations are configured"],
  } };
}

export async function runNotificationWrite(
  session: Session, coordinator: MutationCoordinator, flags: ReadonlyMap<string, string | boolean>,
  action: "create" | "edit" | "delete", redactor: SecretRedactor,
): Promise<LeafResult> {
  requireRux(session);
  const id = action === "create" ? undefined : destinationId(flags);
  let payload: z.infer<typeof documentSchema> | undefined;
  if (action !== "delete") {
    const file = flags.get("config-file");
    let value: unknown;
    try {
      if (typeof file !== "string" || !file.trim()) throw new Error();
      value = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"));
    } catch {
      throw new AxiError("Cannot read --config-file as JSON", "VALIDATION_ERROR", ["Supply --config-file <path|-> with a full destination document"]);
    }
    redactor.notificationSecrets(value);
    const parsed = documentSchema.safeParse(value);
    if (!parsed.success) throw new AxiError("Invalid destination document", "VALIDATION_ERROR", [
      "Supply destination_type, title and config.destination_params.url (HTTP or HTTPS); enabled is optional",
    ]);
    if (containsRedactedPlaceholder(value)) throw new AxiError("--config-file must not contain ***redacted*** placeholders", "VALIDATION_ERROR", [
      "Restore real secrets from your vault instead of copying preview output",
      "Start from the complete preview structure, never the projected api-get subset",
    ]);
    payload = parsed.data;
  }
  const target = id === undefined ? "new notification destination" : `notification destination ${id}`;
  const definition: MutationDefinition = {
    operation: `rux.notification-destination.${action}`, method: action === "create" ? "POST" : action === "edit" ? "PUT" : "DELETE",
    path: `/api/v3.4/notifications/destinations/${id === undefined ? "" : `${id}/`}`,
    effect: "write", target, requiresConfirmation: true, ...(payload ? { payload } : {}),
  };
  coordinator.preview(definition);
  let before: Destination[] | undefined;
  let fingerprints: (string | undefined)[] | undefined;
  const readState = async () => {
    const rows = await readDestinations(session, id);
    const fresh = rows.map((row) => redactor.notificationState(row.id));
    if (before && (!isDeepStrictEqual(before, rows) || !isDeepStrictEqual(fingerprints, fresh))) throw new AxiError(
      "Notification destinations changed before sending", "VERSION_CONFLICT", ["Preview the changed destinations before retrying"],
    );
    if (action === "create" && (rows.length >= 24 || rows.some((row) => row.title === payload!.title))) throw new AxiError(
      "Destination limit or duplicate title prevents creation", "VERSION_CONFLICT", ["Read the destination list and choose a unique title within the 24-destination limit"],
    );
    before = rows;
    fingerprints = fresh;
    return rows;
  };
  const result = await coordinator.execute(definition, {
    execute: flags.has("execute"), dryRun: flags.has("dry-run"), readState,
    ...(typeof flags.get("confirm") === "string" ? { confirm: flags.get("confirm") as string } : {}),
  });
  const common = { profile: session.profile.name, operation: definition.operation, target, warning };
  if (result.kind === "dry-run") return { failed: false, output: {
    ...common, before, after: payload ? redactor.payload(payload) : null,
    help: [`Re-run with --execute --confirm '${target}' to ${action} the destination`],
  } };
  if (result.kind === "success") return { failed: false, output: { ...common, state: "success", audit: result.auditId } };
  if (result.kind === "noop") return { failed: false, output: { ...common, state: "no-op" } };
  return { failed: true, output: { ...common, audit: result.auditId,
    error: result.kind === "failed" ? `Destination ${action} rejected with status ${result.status}` : result.guidance,
    help: ["Read back with `vectra-axi notification destination list` before doing anything else; never replay an unknown outcome"],
  } };
}
