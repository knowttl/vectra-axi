import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inventorySchema } from "../src/inventory/schema.js";

const inventory = JSON.parse(readFileSync(new URL("../inventory/capabilities.json", import.meta.url), "utf8"));

describe("capability inventory", () => {
  it("validates the committed evidence and operation records", () => {
    expect(() => inventorySchema.parse(inventory)).not.toThrow();
  });

  it("makes no runtime support claim before CLI and endpoint slices ship", () => {
    expect(inventorySchema.parse(inventory).operations.every((operation) =>
      operation.disposition === "planned" || operation.disposition === "blocked"
      || operation.disposition === "named",
    )).toBe(true);
  });

  it("marks only the shipped read operations as named", () => {
    const named = inventorySchema.parse(inventory).operations
      .filter((operation) => operation.disposition === "named")
      .map((operation) => operation.id)
      .sort();
    expect(named).toEqual([
      "qux.account.assignment.create",
      "qux.account.assignment.reassign",
      "qux.account.assignment.unassign",
      "qux.account.list",
      "qux.account.note.add",
      "qux.account.note.list",
      "qux.account.show",
      "qux.account.tag.list",
      "qux.account.tag.set",
      "qux.assignment-outcome.list",
      "qux.assignment-outcome.show",
      "qux.assignment.list",
      "qux.audit.list",
      "qux.detection.list",
      "qux.detection.note.add",
      "qux.detection.note.list",
      "qux.detection.show",
      "qux.detection.tag.list",
      "qux.detection.tag.set",
      "qux.entity.account.list",
      "qux.entity.account.show",
      "qux.entity.host.list",
      "qux.entity.host.show",
      "qux.group.list",
      "qux.group.member.list",
      "qux.group.show",
      "qux.health.event.list",
      "qux.health.list",
      "qux.health.show",
      "qux.host.assignment.create",
      "qux.host.assignment.reassign",
      "qux.host.assignment.unassign",
      "qux.host.list",
      "qux.host.note.add",
      "qux.host.note.list",
      "qux.host.show",
      "qux.host.tag.list",
      "qux.host.tag.set",
      "qux.lockdown.account.list",
      "qux.lockdown.host.list",
      "qux.triage-rule.list",
      "qux.triage-rule.show",
      "qux.user.list",
      "qux.user.show",
      "rux.account.list",
      "rux.account.note.list",
      "rux.account.show",
      "rux.account.tag.list",
      "rux.assignment-outcome.list",
      "rux.assignment-outcome.show",
      "rux.assignment.list",
      "rux.audit.list",
      "rux.detection.event.list",
      "rux.detection.list",
      "rux.detection.note.list",
      "rux.detection.show",
      "rux.detection.tag.list",
      "rux.entity.list",
      "rux.entity.scoring.list",
      "rux.entity.show",
      "rux.group.list",
      "rux.group.member.list",
      "rux.group.show",
      "rux.health.edr.details.show",
      "rux.health.edr.show",
      "rux.health.event.list",
      "rux.health.external-connectors.details.show",
      "rux.health.external-connectors.show",
      "rux.health.list",
      "rux.health.network-brain.ping.show",
      "rux.health.show",
      "rux.host.list",
      "rux.host.note.list",
      "rux.host.show",
      "rux.host.tag.list",
      "rux.lockdown.list",
      "rux.triage-rule.list",
      "rux.triage-rule.show",
      "rux.user.list",
      "rux.user.show",
    ]);
  });

  it.each([
    ["missing permission notes", { permissions: undefined }],
    ["numeric API version", { apiVersion: 2.5 }],
    ["preview API version", { apiVersion: "3.5" }],
    ["resource route for another version", { path: "/api/v3.4/detections/" }],
    ["non-GET read", { method: "POST" }],
    ["secret GET disguised as a read", { path: "/api/v2.5/sensor_token" }],
    ["token GET disguised as a read", { path: "/api/v2.5/oauth2/token" }],
    ["credential export classified as planned", { effect: "credential-export", disposition: "planned" }],
    ["unknown evidence source", { evidence: [{ source: "missing", locator: "p1" }] }],
    ["absent fixture expectations", { fixtureCases: [] }],
    ["invented completeness percentage", { completenessPercent: 100 }],
  ])("rejects %s", (_name, patch) => {
    const candidate = structuredClone(inventory);
    Object.assign(candidate.operations[0], patch);
    expect(inventorySchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects duplicate operation IDs", () => {
    const candidate = structuredClone(inventory);
    candidate.operations.push(candidate.operations[0]);
    expect(inventorySchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects the QUX token route for a RUX credential exchange", () => {
    const candidate = structuredClone(inventory);
    const exchange = candidate.operations.find((operation: { id: string }) => operation.id === "rux.oauth.exchange");
    exchange.path = "/api/v3.4/oauth2/token";
    expect(inventorySchema.safeParse(candidate).success).toBe(false);
  });
});
