import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { LoadedConfig, SelectedProfile } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";
import { createMutationSender, mutationNotSent, mutationAccepted, mutationHttpStatus,
  type MutationAuthorization, type MutationMethod, type MutationResponse, type RawTransport } from "./session.js";

// WRITE-00 mutation coordinator shared by named mutation families. The gate
// order follows az-axi's write gates as the reference: read-only default,
// allowWrites plus a scope allowlist, dry run, --execute, --confirm,
// --if-match, a durable write log and an approval hook.

// Forced read-only beats every profile, mirroring AZ_AXI_READ_ONLY.
export const READ_ONLY_ENV = "VECTRA_AXI_READ_ONLY";
export const WRITE_LOG_ENV = "VECTRA_AXI_WRITE_LOG";

export function readOnlyForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[READ_ONLY_ENV] === "1";
}

// Executed mutations are recorded here: VECTRA_AXI_WRITE_LOG when set,
// otherwise ~/.vectra-axi/writes.log. A blank override falls back.
export function resolveWriteLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[WRITE_LOG_ENV]?.trim();
  if (override) return override;
  return join(homedir(), ".vectra-axi", "writes.log");
}

export type MutationEffect = "write" | "disruptive";

// A named mutation bound by its domain caller. The operation must fall
// inside the profile's configured scope; tag replaces and note appends also
// require confirmation.
export type MutationDefinition = {
  operation: string;
  method: MutationMethod;
  path: string;
  effect: MutationEffect;
  target: string;
  requiresConfirmation?: boolean;
  payload?: unknown;
};

export type MutationPreview = {
  operation: string;
  method: MutationMethod;
  url: string;
  effect: MutationEffect;
  target: string;
  noop: boolean;
  currentState: string | null;
  proposedChange: string | null;
};

export type MutationApproval = (preview: MutationPreview) => boolean | Promise<boolean>;

export type MutationExecuteOptions = {
  execute?: boolean;
  dryRun?: boolean;
  confirm?: string;
  ifMatch?: string;
  approval?: MutationApproval;
  readState: () => unknown | Promise<unknown>;
  isNoop?: (current: unknown) => boolean;
  intentId?: string;
};

export type MutationResult =
  | { kind: "dry-run"; preview: MutationPreview }
  | { kind: "noop"; preview: MutationPreview }
  | { kind: "success"; preview: MutationPreview; auditId: string; status: number; response: unknown }
  | { kind: "failed"; preview: MutationPreview; auditId: string; status: number }
  | { kind: "unknown"; preview: MutationPreview; auditId: string; httpStatus: number; guidance: string };

// The immutable original scope: copied from the configured profile when the
// coordinator is created. Read flags, environment profile overrides and
// later raw-read access never widen it because nothing after creation feeds it.
export type WriteScope = Readonly<{
  name: string;
  origin: string;
  apiVersion: string;
  allowWrites: boolean;
  operations: readonly string[];
}>;

export type MutationCoordinator = {
  readonly scope: WriteScope;
  preview(definition: MutationDefinition, current?: unknown, isNoop?: (current: unknown) => boolean): MutationPreview;
  execute(definition: MutationDefinition, options: MutationExecuteOptions): Promise<MutationResult>;
};

type AuditRecord = {
  kind: "intent" | "outcome";
  id: string;
  intentKey: string;
  time: string;
  profile: string;
  operation: string;
  method: MutationMethod;
  url: string;
  target: string;
  effect: MutationEffect;
  ifMatch?: string;
  httpStatus?: number;
  outcome?: string;
};

const authorizations = new WeakMap<MutationAuthorization, object>();

export function consumeMutationAuthorization(authorization: MutationAuthorization, sender: object): boolean {
  if (authorizations.get(authorization) !== sender) return false;
  authorizations.delete(authorization);
  return true;
}

function flushDirectory(path: string): void {
  // Node cannot open directory handles on Windows; journal fsync still applies.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function serialize(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (value !== undefined && serialized === undefined) throw new Error("Not JSON");
    return serialized;
  } catch {
    throw new AxiError("Mutation state or payload is not serializable", "VALIDATION_ERROR", [
      "Provide JSON-serializable current state and payload",
    ]);
  }
}

export function createMutationCoordinator(args: {
  profile: SelectedProfile;
  configPath: LoadedConfig["path"];
  redactor: SecretRedactor;
  transport: RawTransport;
  clock?: () => number;
  auditPath?: string;
}): MutationCoordinator {
  const { profile, configPath, redactor, transport } = args;
  const clock = args.clock ?? Date.now;
  const auditPath = args.auditPath ?? resolveWriteLogPath();
  const scope: WriteScope = Object.freeze({
    name: profile.name,
    origin: profile.origin,
    apiVersion: profile.apiVersion,
    allowWrites: profile.writes?.allowWrites === true,
    operations: Object.freeze([...(profile.writes?.operations ?? [])]),
  });
  const exposedScope = Object.freeze({ ...scope });
  const sender = createMutationSender({ profile, configPath, redactor, transport });

  function enforceWriteGates(definition: MutationDefinition): void {
    // Gate 1: forced read-only overrides every profile.
    // Gate 2: the profile must opt in through hand-edited configuration.
    if (readOnlyForced() || !scope.allowWrites) {
      throw new AxiError(
        `blocked: writes are disabled for profile '${scope.name}' (${definition.method} ${definition.operation})`,
        "WRITES_DISABLED",
        [
          "Writes are disabled for this profile",
          "Gated `tag set` replaces, `note add` appends and `assignment set` changes need a hand-edited writes scope on this profile",
        ],
      );
    }
    // Gate 3: the operation must fall inside the profile's own configured scope.
    if (!scope.operations.includes(definition.operation)) {
      throw new AxiError(
        `blocked: operation '${definition.operation}' is outside the write scope of profile '${scope.name}' (${definition.method} request)`,
        "OPERATION_NOT_WRITABLE",
        [
          "Writes are limited to this profile's configured operations",
          "Only implemented operations can run: `tag set` replaces, `note add` appends and `assignment set` changes",
        ],
      );
    }
  }

  function boundMutationUrl(definition: MutationDefinition): string {
    if (!definition.operation.trim()) {
      throw new AxiError("Mutation operation must be a non-empty name", "VALIDATION_ERROR", [
        "Name the fixture operation the coordinator should authorize",
      ]);
    }
    if (!definition.target.trim()) {
      throw new AxiError("Mutation target must be a non-empty name", "VALIDATION_ERROR", [
        "Name the exact target this mutation would change",
      ]);
    }
    const prefix = `/api/v${scope.apiVersion}/`;
    const segments = definition.path.split("/");
    if (!definition.path.startsWith(prefix) || segments[0] !== ""
      || segments.slice(1).some((segment) => !segment || segment === "." || segment === "..")
      || /[\s\x00-\x1f\x7f\\?#]/.test(definition.path)) {
      throw new AxiError("Refusing mutation path outside the bound operation scope", "VALIDATION_ERROR", [
        `Mutation paths must stay under ${prefix} without traversal, query strings or fragments`,
      ]);
    }
    return `${scope.origin}${definition.path}`;
  }

  function preview(definition: MutationDefinition, current?: unknown, isNoop?: (current: unknown) => boolean): MutationPreview {
    enforceWriteGates(definition);
    const url = boundMutationUrl(definition);
    return Object.freeze({
      operation: definition.operation,
      method: definition.method,
      url,
      effect: definition.effect,
      target: definition.target,
      noop: current === undefined || isNoop === undefined ? false : isNoop(current),
      currentState: current === undefined ? null : redactor.text(serialize(current)!),
      proposedChange: definition.payload === undefined ? null : redactor.text(serialize(definition.payload)!),
    });
  }

  // Metadata only: never payloads, headers, secrets or note bodies.
  function recordAudit(record: Omit<AuditRecord, "time">): void {
    const safe = redactor.value({ ...record, time: new Date(clock()).toISOString() }) as AuditRecord;
    const line = JSON.stringify({ ...safe, intentKey: record.intentKey });
    try {
      const directory = dirname(auditPath);
      const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (firstCreated) {
        let path = directory;
        const parent = dirname(firstCreated);
        while (path !== parent) {
          flushDirectory(path);
          path = dirname(path);
        }
        flushDirectory(parent);
      }
      if (process.platform === "win32" && !existsSync(auditPath)) {
        const journal = openSync(auditPath, "a", 0o600);
        try { fsyncSync(journal); } finally { closeSync(journal); }
      }
      const lockPath = `${auditPath}.lock`;
      const lock = openSync(lockPath, "wx", 0o600);
      try {
        const created = !existsSync(auditPath);
        const journal = openSync(auditPath, "a+", 0o600);
        try {
          if (record.kind === "intent") {
            const contents = readFileSync(journal, "utf8");
            if (contents && !contents.endsWith("\n")) throw new Error("Incomplete mutation journal");
            const records = contents.split("\n").filter(Boolean)
              .map((entry) => JSON.parse(entry) as AuditRecord);
            if (records.some((entry) => !entry || !["intent", "outcome"].includes(entry.kind)
              || typeof entry.intentKey !== "string" || !/^[a-f0-9]{64}$/.test(entry.intentKey))) {
              throw new Error("Invalid mutation journal");
            }
            if (records.some((entry) => entry.kind === "intent" && entry.intentKey === record.intentKey)) {
              throw new AxiError(`blocked: intent '${record.id}' was already reserved`, "ALREADY_EXECUTED", [
                `Intent '${record.id}' requires manual reconciliation; read back its target and never resend it`,
              ]);
            }
          }
          writeFileSync(journal, `${line}\n`);
          fsyncSync(journal);
          if (created) flushDirectory(directory);
        } finally { closeSync(journal); }
      } finally {
        closeSync(lock);
        unlinkSync(lockPath);
      }
    } catch (error) {
      if (error instanceof AxiError && error.code === "ALREADY_EXECUTED") throw error;
      if (record.kind === "intent") {
        throw new AxiError(`Mutation intent '${record.id}' could not be recorded`, "INTENT_NOT_RECORDED", [
          "The mutation was not sent",
          `Check the audit path ${auditPath}; a remaining lock requires manual reconciliation before removal`,
        ]);
      }
      throw new AxiError(`Mutation outcome '${record.id}' could not be recorded`, "OUTCOME_NOT_RECORDED", [
        "The mutation may have been applied; read back the target before doing anything else",
        `Check the audit path ${auditPath}`,
      ]);
    }
  }

  function metadata(definition: MutationDefinition, seen: MutationPreview, id: string, ifMatch: string | undefined): Omit<AuditRecord, "kind" | "time"> {
    return {
      id,
      intentKey: createHash("sha256").update(id).digest("hex"),
      profile: scope.name,
      operation: definition.operation,
      method: definition.method,
      url: seen.url,
      target: definition.target,
      effect: definition.effect,
      ...(ifMatch !== undefined ? { ifMatch } : {}),
    };
  }

  async function execute(definition: MutationDefinition, options: MutationExecuteOptions): Promise<MutationResult> {
    const body = serialize(definition.payload);
    definition = { ...definition, ...(body === undefined ? {} : { payload: JSON.parse(body) as unknown }) };
    options = { ...options };
    if (options.execute === true && options.dryRun === true) {
      throw new AxiError("--dry-run cannot be combined with --execute", "VALIDATION_ERROR", [
        "Omit --execute to preview the mutation without sending it",
      ]);
    }
    const seen = preview(definition, await options.readState(), options.isNoop);
    // Gate 4: without --execute the caller runs the dry run instead.
    if (options.execute !== true) return { kind: "dry-run", preview: seen };
    // Verified already-desired state is a no-op: nothing is sent.
    if (seen.noop) return { kind: "noop", preview: seen };
    if (definition.effect === "disruptive" || definition.requiresConfirmation === true) {
      if (options.confirm === undefined) {
        throw new AxiError(
          `blocked: ${definition.method} needs --confirm '${definition.target}' (profile '${scope.name}')`,
          "CONFIRM_REQUIRED",
          [`Re-run with --confirm '${definition.target}'`],
        );
      }
      if (options.confirm !== definition.target) {
        throw new AxiError(
          `blocked: --confirm '${options.confirm}' does not match target '${definition.target}' (profile '${scope.name}')`,
          "CONFIRM_MISMATCH",
          [`Re-run with --confirm '${definition.target}'`],
        );
      }
    }
    // Gate 6: the approval hook reviews the previewed action.
    if (options.approval !== undefined && !(await options.approval(seen))) {
      throw new AxiError(`blocked: mutation ${definition.operation} was not approved (profile '${scope.name}')`,
        "APPROVAL_DENIED", ["Approve the reviewed preview before executing"]);
    }
    const id = options.intentId ?? randomUUID();
    // A re-read alone is not atomic protection; conditional writes travel as
    // If-Match only where the endpoint supports them (WRITE-N evidence).
    const meta = metadata(definition, seen, id, options.ifMatch);
    // Failure to record intent blocks the send.
    recordAudit({ ...meta, kind: "intent" });
    // Re-read before the single send; a failed re-read aborts without sending.
    let fresh: unknown;
    try {
      fresh = await options.readState();
    } catch (error) {
      recordAudit({ ...meta, kind: "outcome", httpStatus: 0, outcome: "NOT_SENT" });
      throw error;
    }
    if (options.isNoop?.(fresh) === true) {
      recordAudit({ ...meta, kind: "outcome", httpStatus: 0, outcome: "NOT_SENT" });
      return { kind: "noop", preview: seen };
    }
    const authorization = Object.freeze({ nonce: randomUUID(), method: definition.method, url: seen.url });
    authorizations.set(authorization, sender);
    let sent: MutationResponse;
    try {
      sent = await sender.send(authorization, {
        ...(body !== undefined ? { body } : {}),
        ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
      });
    } catch (error) {
      if (mutationNotSent(error)) {
        recordAudit({ ...meta, kind: "outcome", httpStatus: 0, outcome: "NOT_SENT" });
        throw error;
      }
      const httpStatus = mutationHttpStatus(error);
      // A response means the server decided: accepted bodies report SUCCESS,
      // other statuses report FAILED. No response is ambiguous and is never
      // replayed; the audit ID plus read-back guidance replaces the retry.
      if (httpStatus > 0 && mutationAccepted(error)) {
        recordAudit({ ...meta, kind: "outcome", httpStatus, outcome: "SUCCESS" });
        return { kind: "success", preview: seen, auditId: id, status: httpStatus, response: {} };
      }
      if (httpStatus > 0) {
        recordAudit({ ...meta, kind: "outcome", httpStatus, outcome: "FAILED" });
        return { kind: "failed", preview: seen, auditId: id, status: httpStatus };
      }
      recordAudit({ ...meta, kind: "outcome", httpStatus: 0, outcome: "OUTCOME_UNKNOWN" });
      return {
        kind: "unknown",
        preview: seen,
        auditId: id,
        httpStatus: 0,
        guidance: `Mutation ${definition.operation} may or may not have been applied (audit ${id}); read back target '${definition.target}' before doing anything else; never replay this intent`,
      };
    }
    recordAudit({ ...meta, kind: "outcome", httpStatus: sent.status, outcome: "SUCCESS" });
    return { kind: "success", preview: seen, auditId: id, status: sent.status, response: sent.body };
  }

  return { scope: exposedScope, preview, execute };
}
