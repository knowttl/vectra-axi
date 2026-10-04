import { runAxiCli } from "axi-sdk-js";
import { auditWindow, runAuditList, type LeafResult as AuditLeafResult } from "./audits.js";
import { healthCheck, healthEventFlags, healthEventRelease, runHealthEventList, runHealthList,
  runHealthShow, type LeafResult as HealthLeafResult } from "./health.js";
import { ASSIGNMENT_LIST_FIELDS, assignmentQuery, listFields as assignmentListFields, listLimit as assignmentListLimit,
  outcomeId, OUTCOME_LIST_FIELDS, runAssignmentList, runOutcomeList, runOutcomeShow, runUserList, runUserShow,
  userId, USER_LIST_FIELDS, userQuery,
  type LeafResult as AssignmentLeafResult } from "./assignments.js";
import { GROUP_LIST_FIELDS, groupQuery, runGroupList, runGroupMemberList, runGroupShow,
  MEMBER_LIST_FIELDS, memberQuery, RULE_LIST_FIELDS, ruleQuery, runRuleList, runRuleShow,
  groupId, ruleId, listFields as groupListFields, listLimit as groupListLimit,
  type LeafResult as GroupLeafResult } from "./groups.js";
import { catalogue, DESCRIPTION, help, inventory, parseInvocation } from "./catalogue.js";
import { listFields, listLimit, listQuery, runDetectionList, runDetectionShow, showId, type LeafResult } from "./detections.js";
import { doctorTargets, runDoctor } from "./doctor.js";
import { lockdownKind, runLockdownList, type LeafResult as LockdownLeafResult } from "./lockdown.js";
import { entityKind, listFields as entityListFields, listLimit as entityListLimit, listQuery as entityListQuery,
  runAccountList, runAccountShow, runEntityList, runEntityShow, runHostList, runHostShow,
  showId as entityShowId } from "./entities.js";
import { NOTE_KINDS, noteOwnerId, runNoteList, runTagList, type NoteKind } from "./notes.js";
import { loadConfig, selectProfile } from "./profiles.js";
import { SecretRedactor } from "./redact.js";
import { createSession, nodeTransport, type RawTransport } from "./session.js";

const ASSIGNMENT_FIELDS = {
  "assignment list": ASSIGNMENT_LIST_FIELDS,
  "assignment outcome list": OUTCOME_LIST_FIELDS,
  "user list": USER_LIST_FIELDS,
} as const;

// Module scope: the shell handler runs inside runAxiCli before main's body
// reaches any later declaration, so leaf field tables must not live there.
const GROUP_FIELDS = {
  "group list": GROUP_LIST_FIELDS,
  "group member list": MEMBER_LIST_FIELDS,
  "triage rule list": RULE_LIST_FIELDS,
} as const;

export async function main(argv = process.argv.slice(2), transport: RawTransport = nodeTransport()): Promise<void> {
  let invocation: ReturnType<typeof parseInvocation>;
  const redactor = new SecretRedactor();
  const stdout = {
    write: (chunk: string) => process.stdout.write(redactor.text(chunk)),
    on: process.stdout.on.bind(process.stdout),
  };
  await runAxiCli({
    description: DESCRIPTION,
    // Route all input through the catalogue before SDK shortcuts or handlers.
    initialize: () => redactor.boundary(() => { invocation = parseInvocation(argv); }),
    argv: argv.length === 0 ? [] : ["shell"],
    topLevelHelp: "",
    stdout,
    home: () => guarded(async () => state()),
    commands: {
      // Leaf validation throws before any profile or transport work, so
      // unknown flags and invalid combinations never reach credentials.
      shell: () => guarded(async (): Promise<Record<string, unknown>> => {
        if (invocation.help) return help(invocation.home ? undefined : invocation.leaf);
        if (invocation.leaf === "doctor") {
          return runDoctorLeaf(invocation.flags);
        }
        if (invocation.leaf === "detection list" || invocation.leaf === "detection show") {
          return runDetection(invocation.leaf, invocation.flags);
        }
        if (invocation.leaf === "host list" || invocation.leaf === "host show"
          || invocation.leaf === "account list" || invocation.leaf === "account show"
          || invocation.leaf === "entity list" || invocation.leaf === "entity show") {
          return runEntity(invocation.leaf, invocation.flags);
        }
        if (invocation.leaf === "detection note list" || invocation.leaf === "detection tag list"
          || invocation.leaf === "host note list" || invocation.leaf === "host tag list"
          || invocation.leaf === "account note list" || invocation.leaf === "account tag list") {
          return runNotes(invocation.leaf, invocation.flags);
        }
        if (invocation.leaf === "assignment list" || invocation.leaf === "assignment outcome list"
          || invocation.leaf === "assignment outcome show"
          || invocation.leaf === "user list" || invocation.leaf === "user show") {
          return runAssignment(invocation.leaf, invocation.flags);
        }
        if (invocation.leaf === "audit list") {
          return runAudit(invocation.flags);
        }
        if (invocation.leaf === "lockdown list") {
          return runLockdown(invocation.flags);
        }
        if (invocation.leaf === "group list" || invocation.leaf === "group show"
          || invocation.leaf === "group member list"
          || invocation.leaf === "triage rule list" || invocation.leaf === "triage rule show") {
          return runGroups(invocation.leaf, invocation.flags);
        }
        if (invocation.leaf === "health list" || invocation.leaf === "health show"
          || invocation.leaf === "health event list") {
          return runHealth(invocation.leaf, invocation.flags);
        }
        return state();
      }),
    },
  });

  // Await async failures before applying the synchronous redactor boundary,
  // so the SDK only receives scrubbed errors.
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      return redactor.boundary((): T => { throw error; });
    }
  }

  // One dispatch for every note/tag leaf: validate the owner ID, select the
  // profile, build the session on the injected transport, and return the
  // shaped single-response output.
  type NotesLeaf = "detection note list" | "detection tag list"
    | "host note list" | "host tag list" | "account note list" | "account tag list";
  async function runNotes(leaf: NotesLeaf, flags: ReadonlyMap<string, string | boolean>): Promise<Record<string, unknown>> {
    const kind = leaf.split(" ")[0] as NoteKind;
    if (!(NOTE_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Unknown note/tag leaf: ${leaf}`);
    }
    noteOwnerId(flags, leaf, kind);
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: LeafResult = leaf.endsWith("note list")
      ? await runNoteList(session, flags, kind)
      : await runTagList(session, flags, kind);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  // One dispatch for every host/account/entity leaf: validate the kind and
  // flags, select the profile, build the session on the injected transport,
  // and report partial reads with their rows and a nonzero exit status.
  type EntityLeaf = "host list" | "host show" | "account list" | "account show" | "entity list" | "entity show";
  async function runEntity(leaf: EntityLeaf, flags: ReadonlyMap<string, string | boolean>): Promise<Record<string, unknown>> {
    const facade = leaf.startsWith("entity ");
    if (facade) entityKind(flags);
    if (leaf.endsWith(" list")) {
      entityListQuery(flags, facade);
      entityListLimit(flags);
      entityListFields(flags, facade);
    } else {
      entityShowId(flags, leaf);
    }
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: LeafResult = leaf === "host list" ? await runHostList(session, flags)
      : leaf === "account list" ? await runAccountList(session, flags)
      : leaf === "entity list" ? await runEntityList(session, flags)
      : leaf === "host show" ? await runHostShow(session, flags)
      : leaf === "account show" ? await runAccountShow(session, flags)
      : await runEntityShow(session, flags);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  // One dispatch for every detection leaf: validate flags, select the
  // profile, build the session on the injected transport, and report
  // partial reads with their rows and a nonzero exit status.
  async function runDetection(
    leaf: "detection list" | "detection show", flags: ReadonlyMap<string, string | boolean>,
  ): Promise<Record<string, unknown>> {
    if (leaf === "detection list") {
      listQuery(flags);
      listLimit(flags);
      listFields(flags);
    } else {
      showId(flags);
    }
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: LeafResult = leaf === "detection list"
      ? await runDetectionList(session, flags)
      : await runDetectionShow(session, flags);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  // One dispatch for every assignment/outcome/user leaf: validate the
  // flags, select the profile, build the session on the injected transport,
  // and report partial reads with their rows and a nonzero exit status.
  // Assignment leaves are read-only; no resolve or reassign leaf exists.
  type AssignmentLeaf = "assignment list" | "assignment outcome list" | "assignment outcome show"
    | "user list" | "user show";
  async function runAssignment(leaf: AssignmentLeaf, flags: ReadonlyMap<string, string | boolean>): Promise<Record<string, unknown>> {
    if (leaf === "assignment list") {
      assignmentQuery(flags);
      assignmentListLimit(flags);
      assignmentListFields(flags, ASSIGNMENT_FIELDS[leaf]);
    } else if (leaf === "assignment outcome list" || leaf === "user list") {
      if (leaf === "user list") userQuery(flags);
      assignmentListLimit(flags);
      assignmentListFields(flags, ASSIGNMENT_FIELDS[leaf]);
    } else if (leaf === "assignment outcome show") {
      outcomeId(flags);
    } else {
      userId(flags);
    }
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: AssignmentLeafResult = leaf === "assignment list" ? await runAssignmentList(session, flags)
      : leaf === "assignment outcome list" ? await runOutcomeList(session, flags)
      : leaf === "assignment outcome show" ? await runOutcomeShow(session, flags)
      : leaf === "user list" ? await runUserList(session, flags)
      : await runUserShow(session, flags);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  // One dispatch for every health leaf: validate the flags, select the
  // profile, build the session on the injected transport, and return the
  // shaped output. Snapshots validate the check selector and report cached
  // versus fresh from the request; the event feed enforces its 9.4 release
  // gate and follows returned checkpoints. Denial propagates from the
  // session, never as an empty healthy result. No health mutation exists.
  type HealthLeaf = "health list" | "health show" | "health event list";
  async function runHealth(leaf: HealthLeaf, flags: ReadonlyMap<string, string | boolean>): Promise<Record<string, unknown>> {
    if (leaf === "health show") {
      healthCheck(flags);
    } else if (leaf === "health event list") {
      healthEventFlags(flags);
    }
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    if (leaf === "health event list") healthEventRelease(selected);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: HealthLeafResult = leaf === "health list" ? await runHealthList(session, flags)
      : leaf === "health show" ? await runHealthShow(session, flags)
      : await runHealthEventList(session, flags);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  // One dispatch for the audit leaf: validate the bounded window, select
  // the profile, build the session on the injected transport, and return
  // the shaped single-window output. Oversized or malformed windows throw
  // instead of claiming completion; denial propagates from the session.
  async function runAudit(flags: ReadonlyMap<string, string | boolean>): Promise<Record<string, unknown>> {
    auditWindow(flags);
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: AuditLeafResult = await runAuditList(session, flags);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  // One dispatch for the lockdown leaf: validate the status kind, select
  // the profile, build the session on the injected transport, and return
  // the shaped single-response output. Status only: no execution leaf
  // exists, and denial propagates from the session as an error.
  async function runLockdown(flags: ReadonlyMap<string, string | boolean>): Promise<Record<string, unknown>> {
    lockdownKind(flags);
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: LockdownLeafResult = await runLockdownList(session, flags);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  // One dispatch for every group/member/rule leaf: validate the flags,
  // select the profile, build the session on the injected transport, and
  // report partial reads with their rows and a nonzero exit status.
  // Group and rule leaves are read-only; no group or rule mutation leaf exists.
  type GroupsLeaf = "group list" | "group show" | "group member list"
    | "triage rule list" | "triage rule show";
  async function runGroups(leaf: GroupsLeaf, flags: ReadonlyMap<string, string | boolean>): Promise<Record<string, unknown>> {
    if (leaf === "group list") {
      groupQuery(flags);
      groupListLimit(flags);
      groupListFields(flags, GROUP_FIELDS[leaf]);
    } else if (leaf === "group member list") {
      groupId(flags, leaf);
      memberQuery(flags);
      groupListLimit(flags);
      groupListFields(flags, GROUP_FIELDS[leaf]);
    } else if (leaf === "triage rule list") {
      ruleQuery(flags);
      groupListLimit(flags);
      groupListFields(flags, GROUP_FIELDS[leaf]);
    } else if (leaf === "group show") {
      groupId(flags, leaf);
    } else {
      ruleId(flags);
    }
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: GroupLeafResult = leaf === "group list" ? await runGroupList(session, flags)
      : leaf === "group show" ? await runGroupShow(session, flags)
      : leaf === "group member list" ? await runGroupMemberList(session, flags)
      : leaf === "triage rule list" ? await runRuleList(session, flags)
      : await runRuleShow(session, flags);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  // One dispatch for the doctor leaf: load the configuration, resolve the
  // explicit profile or every configured profile, and report the bounded
  // per-profile reads with a nonzero exit status when any profile fails.
  // Configuration errors throw before any HTTP; doctor --help stays offline.
  async function runDoctorLeaf(flags: ReadonlyMap<string, string | boolean>): Promise<Record<string, unknown>> {
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const names = doctorTargets(loaded.config, flags.get("profile") as string | undefined);
    const result = await runDoctor({ loaded, names,
      configFlag: flags.get("config") as string | undefined, redactor, transport });
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  function state(): Record<string, unknown> {
    const loaded = loadConfig(invocation.flags.get("config") as string | undefined, redactor);
    const count = Object.keys(loaded.config.profiles).length;
    const selected = count || invocation.flags.has("profile") || process.env.VECTRA_AXI_PROFILE
      ? selectProfile(loaded.config, invocation.flags.get("profile") as string | undefined) : undefined;
    return {
      ...(invocation.home ? {} : { command: `vectra-axi ${invocation.leaf}` }),
      state: selected ? "configured" : "unconfigured",
      profiles: count,
      ...(selected ? { profile: {
        name: selected.name, source: selected.source, kind: selected.kind, origin: selected.origin,
        apiVersion: selected.apiVersion, ...(selected.applianceRelease ? { applianceRelease: selected.applianceRelease } : {}),
        auth: selected.auth, tls: selected.caBundle ? "verified with private CA" : "verified with system CAs",
        writes: "disabled",
      } } : {}),
      setup: {
        config: loaded.path,
        guidance: "Hand-edit profiles in this user config or select --config <path>; secrets use tokenEnv or secretEnv references",
        example: { profiles: { lab: { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "VECTRA_LAB_TOKEN" } } },
        integration: "Detection, host, account, type-qualified entity, note, tag, assignment, outcome, user, group, member, triage rule, audit, health and lockdown reads call the session; doctor checks each profile with one bounded detection read; the static skill at skills/vectra-axi/SKILL.md is installed only by explicit setup",
      },
      capabilities: {
        implemented: Object.keys(catalogue),
        api: "QUX v2.5 detection, host, account, type-qualified entity, note, tag, assignment, outcome, user, group, member, triage rule, audit, health and lockdown reads; every other operation is planned or blocked",
        planned: inventory.operations.filter((operation) => operation.disposition === "planned").length,
        blocked: inventory.operations.filter((operation) => operation.disposition === "blocked").length,
      },
      help: ["Run vectra-axi setup --help", "Run vectra-axi --help"],
    };
  }
}
