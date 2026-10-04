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

  it("marks only the shipped detection and entity reads as named", () => {
    const named = inventorySchema.parse(inventory).operations
      .filter((operation) => operation.disposition === "named")
      .map((operation) => operation.id)
      .sort();
    expect(named).toEqual([
      "qux.account.list",
      "qux.account.note.list",
      "qux.account.show",
      "qux.account.tag.list",
      "qux.assignment-outcome.list",
      "qux.assignment-outcome.show",
      "qux.assignment.list",
      "qux.audit.list",
      "qux.detection.list",
      "qux.detection.note.list",
      "qux.detection.show",
      "qux.detection.tag.list",
      "qux.entity.account.list",
      "qux.entity.account.show",
      "qux.entity.host.list",
      "qux.entity.host.show",
      "qux.group.list",
      "qux.group.member.list",
      "qux.group.show",
      "qux.host.list",
      "qux.host.note.list",
      "qux.host.show",
      "qux.host.tag.list",
      "qux.triage-rule.list",
      "qux.triage-rule.show",
      "qux.user.list",
      "qux.user.show",
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
