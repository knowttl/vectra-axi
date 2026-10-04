import { AxiError } from "axi-sdk-js";
import { runDetectionList } from "./detections.js";
import { createSession, credentialProvider, type RawTransport } from "./session.js";
import { selectProfile, type LoadedConfig } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";

// Explicit checks use the session's credential and transport policy.
// See README.md#release for generation-specific checks and usage.

export const DOCTOR_OPERATION = "qux.detection.list";
export const DOCTOR_WINDOW = 1;
export const DOCTOR_CHECK = `detection list --limit ${DOCTOR_WINDOW} (${DOCTOR_OPERATION})`;
// RUX-01: cloud profiles have no reads yet (RUX-02+), so their check is the
// named OAuth exchange alone. It proves configuration, connectivity and
// authentication without touching a read route.
export const RUX_DOCTOR_CHECK = "oauth exchange (rux.oauth.exchange); RUX reads arrive in RUX-02";

// Explicit --profile wins; otherwise environment, configured default and the
// sole profile select one target. With no selection among several profiles,
// doctor checks every profile instead of failing ambiguous.
export function doctorTargets(config: LoadedConfig["config"], flag?: string): string[] {
  if ((flag ?? process.env.VECTRA_AXI_PROFILE ?? config.defaultProfile) !== undefined) {
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
  let sawRux = false;
  for (const name of names) {
    const selected = selectProfile(loaded.config, name);
    const check = selected.kind === "rux" ? RUX_DOCTOR_CHECK : DOCTOR_CHECK;
    if (selected.kind === "rux") sawRux = true;
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const flags = new Map<string, string | boolean>([["limit", String(DOCTOR_WINDOW)]]);
    const context = ` --config ${shellQuote(loaded.path)} --profile=${shellQuote(name)}`;
    const recovery = `[${name}] Check the reported failure, then rerun \`vectra-axi doctor${context}\``;
    try {
      if (selected.kind === "rux") {
        await credentialProvider({ profile: selected, configPath: loaded.path, redactor, transport })();
        ok += 1;
        rows.push({ name, auth: selected.auth, check, status: "ok",
          detail: "OAuth exchange ok; RUX reads arrive in RUX-02" });
      } else {
        const result = await runDetectionList(session, flags);
        if (result.failed) {
          const output = result.output as { code: unknown; error: unknown };
          rows.push({ name, auth: selected.auth, check, status: "failed",
            code: output.code, error: output.error });
          note(recovery);
        } else {
          ok += 1;
          const output = result.output as { count: unknown };
          rows.push({ name, auth: selected.auth, check, status: "ok", detail: output.count });
        }
      }
    } catch (error) {
      if (!(error instanceof AxiError)) throw error;
      rows.push({ name, auth: selected.auth, check, status: "failed",
        code: error.code, error: error.message });
      for (const hint of [error.message, ...error.suggestions]) note(`[${name}] ${hint}`);
      note(recovery);
    }
  }
  const failed = ok !== names.length;
  if (!failed) {
    for (const name of names) {
      const selected = selectProfile(loaded.config, name);
      if (selected.kind === "rux") {
        note(`[${name}] RUX reads arrive in RUX-02; rerun \`vectra-axi doctor --config ${shellQuote(loaded.path)} --profile=${shellQuote(name)}\` after upgrading`);
      } else {
        note(`Run \`vectra-axi detection list --config ${shellQuote(loaded.path)} --profile=${shellQuote(name)}\` to start an investigation`);
      }
    }
  }
  return { failed, output: {
    config: loaded.path,
    check: sawRux
      ? `${DOCTOR_CHECK} per QUX profile, ${RUX_DOCTOR_CHECK} per RUX profile; no passwords, no interactive sign-in, no writes`
      : `${DOCTOR_CHECK} per profile; no passwords, no interactive sign-in, no writes`,
    count: `${ok} of ${names.length} profiles ok`,
    profiles: rows,
    complete: !failed,
    help,
  } };
}
