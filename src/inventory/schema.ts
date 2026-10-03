import { z } from "zod";

const text = z.string().trim().min(1);
const names = z.array(text).refine((values) => new Set(values).size === values.length, "Duplicate value");
const version = z.string().regex(/^\d+\.\d+$/);
const evidence = z.array(z.strictObject({ source: text, locator: text })).min(1);
const disposition = z.enum(["named", "reviewed-raw", "planned", "blocked", "unavailable", "deprecated", "unreviewed"]);

export const operationSchema = z.strictObject({
  id: z.string().regex(/^(qux|rux)\.[a-z0-9.-]+$/),
  command: text.nullable(),
  slice: text,
  deployment: z.enum(["qux", "rux"]),
  apiVersion: version,
  minimumRelease: version.nullable(),
  constraints: text,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().regex(/^\/(?:api\/v\d+\.\d+\/|oauth2\/)[A-Za-z0-9_{}./-]+$/),
  effect: z.enum(["read", "auth-exchange", "credential-export", "write", "disruptive"]),
  query: names,
  fields: names,
  paging: z.enum(["none", "collection", "checkpoint", "date-window"]),
  permissions: text,
  licence: text,
  evidence,
  disposition,
  rationale: text,
  fixtureCases: names.refine((values) => values.length > 0, "Fixture cases required"),
}).superRefine((operation, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  const expectedVersion = operation.deployment === "qux" ? "2.5" : "3.4";
  if (!operation.id.startsWith(`${operation.deployment}.`)) reject("Operation ID must match deployment");
  if (operation.apiVersion !== expectedVersion) reject("Only QUX 2.5 and RUX 3.4 are inventoried");
  if (operation.deployment === "rux" && operation.minimumRelease !== null) reject("RUX has no appliance-release gate");
  const tokenPath = operation.deployment === "qux" ? "/api/v2.5/oauth2/token" : "/oauth2/token";
  if (operation.path === tokenPath && operation.effect !== "auth-exchange") reject("Token route requires auth-exchange effect");
  if (operation.effect === "auth-exchange") {
    if (operation.method !== "POST" || operation.path !== tokenPath) reject("Authentication exchange must use the exact generation token route");
  } else if (!operation.path.startsWith(`/api/v${operation.apiVersion}/`)) {
    reject("Resource route must match the API version");
  }
  if (operation.effect === "read" && operation.method !== "GET") reject("A read must use GET");
  if (["/api/v2.5/sensor_token", "/api/v2.5/settings/aws_connectors"].includes(operation.path.replace(/\/$/, "")) && operation.effect !== "credential-export") reject("Known secret route requires credential-export effect");
  if (operation.effect === "credential-export" && operation.disposition !== "blocked") reject("Credential exports must remain blocked");
  if (["named", "reviewed-raw"].includes(operation.disposition) && operation.command === null) reject("Supported operation needs a command leaf");
});

export const inventorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  reviewedOn: z.iso.date(),
  scope: text,
  sources: z.array(z.strictObject({
    id: text,
    url: z.url({ protocol: /^https$/ }),
    revision: text,
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    reviewedOn: z.iso.date(),
  })).min(1),
  operations: z.array(operationSchema).min(1),
  deferredFamilies: z.array(z.strictObject({
    id: text,
    deployment: z.enum(["qux", "rux"]),
    apiVersion: version,
    disposition: z.enum(["planned", "unreviewed"]),
    rationale: text,
    evidence,
  })),
}).superRefine((inventory, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  const sourceIds = inventory.sources.map((source) => source.id);
  if (new Set(sourceIds).size !== sourceIds.length) reject("Duplicate source ID");
  const ids = [...inventory.operations, ...inventory.deferredFamilies].map((record) => record.id);
  if (new Set(ids).size !== ids.length) reject("Duplicate inventory ID");
  for (const record of [...inventory.operations, ...inventory.deferredFamilies]) {
    if (record.apiVersion !== (record.deployment === "qux" ? "2.5" : "3.4")) reject("Binding must match deployment version");
    for (const reference of record.evidence) {
      if (!sourceIds.includes(reference.source)) reject(`Unknown evidence source: ${reference.source}`);
    }
  }
});

export type CapabilityInventory = z.infer<typeof inventorySchema>;
export type CapabilityOperation = z.infer<typeof operationSchema>;
