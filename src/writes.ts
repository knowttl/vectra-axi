import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { LoadedConfig, SelectedProfile } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";
import { createMutationSender, mutationAccepted, mutationHttpStatus,
  type MutationMethod, type RawTransport } from "./session.js";

// WRITE-00 mutation coordinator: fixture-only enablement for later named
// mutation families. No user-visible mutation command ships in this piece;
// tests drive the coordinator through a fixture mutation only. The gate
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

// A fixture-supplied mutation. WRITE-00 enables no real family: the only
// operable definitions come from tests, and the operation must fall inside
// the profile's configured scope. WRITE-01 binds real families to this shape.
export type MutationDefinition = {
  operation: string;
  method: MutationMethod;
  path: string;
  effect: MutationEffect;
  target: string;
  payload?: unknown;
};

export type MutationPreview = {
  operation: string;
  method: MutationMethod;
  url: string;
  effect: MutationEffect;
  target: string;
  noop: boolean;
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
export type WriteScope = {
  name: string;
  origin: string;
  apiVersion: string;
  allowWrites: boolean;
  operations: readonly string[];
};

export type MutationCoordinator = {
  readonly scope: WriteScope;
  preview(definition: MutationDefinition, current?: unknown, isNoop?: (current: unknown) => boolean): MutationPreview;
  execute(definition: MutationDefinition, options: MutationExecuteOptions): Promise<MutationResult>;
};

type AuditRecord = {
  kind: "intent" | "outcome";
  id: string;
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

export function createMutationCoordinator(args: {
  profile: SelectedProfile;
  configPath: LoadedConfig["path"];
  redactor: SecretRedactor;
  transport: RawTransport;
  clock?: () => number;
  auditPath?: string;
  newId?: () => string;
}): MutationCoordinator {
  const { profile, configPath, redactor, transport } = args;
  const clock = args.clock ?? Date.now;
  const auditPath = args.auditPath ?? resolveWriteLogPath();
  let idCounter = 0;
  const newId = args.newId ?? (() => {
    idCounter += 1;
    return `${clock().toString(36)}-${idCounter.toString(36)}`;
  });
  const scope: WriteScope = {
    name: profile.name,
    origin: profile.origin,
    apiVersion: profile.apiVersion,
    allowWrites: profile.writes?.allowWrites === true,
    operations: [...(profile.writes?.operations ?? [])],
  };
  const sender = createMutationSender({ profile, configPath, redactor, transport });
  const spentIntents = new Set<string>();

  function enforceWriteGates(definition: MutationDefinition): void {
    // Gate 1: forced read-only overrides every profile.
    // Gate 2: the profile must opt in through hand-edited configuration.
    if (readOnlyForced() || !scope.allowWrites) {
      throw new AxiError(
        `blocked: writes are disabled for profile '${scope.name}' (${definition.method} ${definition.operation})`,
        "WRITES_DISABLED",
        [
          "Writes are disabled for this profile",
          "WRITE-00 supports fixture-driven coordinator tests only; no mutation command is available",
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
          "WRITE-00 supports fixture-driven coordinator tests only; no mutation command is available",
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
    return {
      operation: definition.operation,
      method: definition.method,
      url,
      effect: definition.effect,
      target: definition.target,
      noop: current === undefined || isNoop === undefined ? false : isNoop(current),
    };
  }

  // Metadata only: never payloads, headers, secrets or note bodies.
  function recordAudit(record: Omit<AuditRecord, "time">): void {
    const line = redactor.text(JSON.stringify({ ...record, time: new Date(clock()).toISOString() }));
    try {
      mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 });
      appendFileSync(auditPath, `${line}\n`, { mode: 0o600 });
    } catch {
      if (record.kind === "intent") {
        throw new AxiError(`Mutation intent '${record.id}' could not be recorded`, "INTENT_NOT_RECORDED", [
          "The mutation was not sent",
          `Check the audit path ${auditPath} and retry with a new preview`,
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
    // Gate 5: disruptive mutations need the target name back.
    if (definition.effect === "disruptive") {
      if (options.confirm === undefined) {
        throw new AxiError(
          `blocked: disruptive ${definition.method} needs --confirm '${definition.target}' (profile '${scope.name}')`,
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
    // No ambiguous replay: one intent ID executes at most once per coordinator.
    const id = options.intentId ?? newId();
    if (spentIntents.has(id)) {
      throw new AxiError(`blocked: intent '${id}' was already executed; ambiguous outcomes are never replayed`,
        "ALREADY_EXECUTED", [
          `Read back the target of intent '${id}' instead of resending it`,
        ]);
    }
    let body: string | undefined;
    if (definition.payload !== undefined) {
      try {
        body = JSON.stringify(definition.payload);
      } catch {
        throw new AxiError("Mutation payload is not serializable", "VALIDATION_ERROR", [
          "Provide a JSON-serializable payload",
        ]);
      }
    }
    // A re-read alone is not atomic protection; conditional writes travel as
    // If-Match only where the endpoint supports them (WRITE-N evidence).
    // Minting and validation happen before the intent record so a failure
    // here leaves no dangling intent behind.
    const authorization = sender.authorize({ method: definition.method, url: seen.url });
    const meta = metadata(definition, seen, id, options.ifMatch);
    // Failure to record intent blocks the send.
    recordAudit({ ...meta, kind: "intent" });
    spentIntents.add(id);
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
    try {
      const sent = await sender.send(authorization, {
        ...(body !== undefined ? { body } : {}),
        ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
      });
      recordAudit({ ...meta, kind: "outcome", httpStatus: sent.status, outcome: "SUCCESS" });
      return { kind: "success", preview: seen, auditId: id, status: sent.status, response: sent.body };
    } catch (error) {
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
  }

  return { scope, preview, execute };
}
