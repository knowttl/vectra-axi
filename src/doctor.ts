import { AxiError } from "axi-sdk-js";
import { runDetectionList } from "./detections.js";
import { createSession, type RawTransport } from "./session.js";
import { selectProfile, type LoadedConfig } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";

// PACK-01: explicit release health check over the reviewed read-only session.
// Doctor performs one documented bounded read per profile
// (qux.detection.list with a one-row window) and reports configuration,
// connectivity, authentication and access failures without trying passwords,
// signing in interactively or enabling writes. Token profiles resolve their
// configured secret reference exactly as read leaves do; OAuth profiles use
// the named client-credentials exchange only. See README.md for usage.

export const DOCTOR_OPERATION = "qux.detection.list";
export const DOCTOR_WINDOW = 1;
export const DOCTOR_CHECK = `detection list --limit ${DOCTOR_WINDOW} (${DOCTOR_OPERATION})`;

// Explicit --profile wins; otherwise environment, configured default and the
// sole profile select one target. With no selection among several profiles,
// doctor checks every profile instead of failing ambiguous.
export function doctorTargets(config: LoadedConfig["config"], flag?: string): string[] {
  if (flag ?? process.env.VECTRA_AXI_PROFILE ?? config.defaultProfile) {
    return [selectProfile(config, flag).name];
  }
  const names = Object.keys(config.profiles);
  if (names.length <= 1) return [selectProfile(config, flag).name];
  return names;
}

export type DoctorResult = { output: Record<string, unknown>; failed: boolean };

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function runDoctor(args: {
  loaded: LoadedConfig;
  names: string[];
  redactor: SecretRedactor;
  transport: RawTransport;
}): Promise<DoctorResult> {
  const { loaded, names, redactor, transport } = args;
  const rows: Record<string, unknown>[] = [];
  const help: string[] = [];
  const seen = new Set<string>();
  const note = (line: string): void => {
    if (!seen.has(line)) {
      seen.add(line);
      help.push(line);
    }
  };
  let ok = 0;
  for (const name of names) {
    const selected = selectProfile(loaded.config, name);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const flags = new Map<string, string | boolean>([["limit", String(DOCTOR_WINDOW)]]);
    const context = ` --config ${shellQuote(loaded.path)} --profile=${shellQuote(name)}`;
    const recovery = `[${name}] Check the reported failure, then rerun \`vectra-axi doctor${context}\``;
    try {
      const result = await runDetectionList(session, flags);
      if (result.failed) {
        const output = result.output as { code: unknown; error: unknown };
        rows.push({ name, auth: selected.auth, check: DOCTOR_CHECK, status: "failed",
          code: output.code, error: output.error });
        note(recovery);
      } else {
        ok += 1;
        const output = result.output as { count: unknown };
        rows.push({ name, auth: selected.auth, check: DOCTOR_CHECK, status: "ok", detail: output.count });
      }
    } catch (error) {
      if (!(error instanceof AxiError)) throw error;
      rows.push({ name, auth: selected.auth, check: DOCTOR_CHECK, status: "failed",
        code: error.code, error: error.message });
      for (const hint of [error.message, ...error.suggestions]) note(`[${name}] ${hint}`);
      note(recovery);
    }
  }
  const failed = ok !== names.length;
  if (!failed) {
    for (const name of names) {
      note(`Run \`vectra-axi detection list --config ${shellQuote(loaded.path)} --profile=${shellQuote(name)}\` to start an investigation`);
    }
  }
  return { failed, output: {
    config: loaded.path,
    check: `${DOCTOR_CHECK} per profile; no passwords, no interactive sign-in, no writes`,
    count: `${ok} of ${names.length} profiles ok`,
    profiles: rows,
    complete: !failed,
    help,
  } };
}
