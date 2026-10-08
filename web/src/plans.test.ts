import { describe, expect, it } from "vitest";
import { effectivePlan } from "./planEffects";
import {
  comparisonRows,
  formatPrice,
  FREE_FALLBACK,
  isRunning,
  priceParts,
  type Entitlement,
  type PlanInfo,
} from "./plans";

const plan = (over: Partial<PlanInfo>): PlanInfo => ({
  ...FREE_FALLBACK,
  ...over,
});
const FREE = plan({});
const MONTHLY = plan({
  id: "monthly",
  kind: "monthly",
  name: "Pro",
  priceCents: 900,
  maxDiagrams: 5,
  maxTablesPerDiagram: 100,
  features: {
    export: true,
    codeFormats: true,
    themes: true,
    localCopy: false,
    setup: false,
  },
});
const LIFETIME = plan({
  id: "lifetime",
  kind: "lifetime",
  name: "Lifetime",
  priceCents: 19900,
  maxDiagrams: 50,
  maxTablesPerDiagram: 500,
  features: {
    export: true,
    codeFormats: true,
    themes: true,
    localCopy: true,
    setup: true,
  },
});
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

describe("prices", () => {
  it("writes whole amounts without cents and others with two digits", () => {
    expect(formatPrice(900, "USD")).toBe("$9");
    expect(formatPrice(1299, "USD")).toBe("$12.99");
  });
  it("falls back to the code for a currency it does not know", () => {
    expect(formatPrice(50000, "ZZZZ")).toBe("ZZZZ 500");
  });
  it("names the period on each kind of plan", () => {
    expect(priceParts(FREE)).toEqual({ amount: "Free", period: "for ever" });
    expect(priceParts(MONTHLY).period).toBe("per month");
    expect(priceParts(LIFETIME).period).toBe("one-time payment");
  });
});

describe("isRunning", () => {
  it("is true for free and lifetime plans, and for a monthly plan only until its end", () => {
    expect(isRunning({ kind: "free", expiresAt: null })).toBe(true);
    expect(isRunning({ kind: "lifetime", expiresAt: null })).toBe(true);
    expect(isRunning({ kind: "monthly", expiresAt: future })).toBe(true);
    expect(isRunning({ kind: "monthly", expiresAt: past })).toBe(false);
    expect(isRunning({ kind: "monthly", expiresAt: null })).toBe(false);
  });
});

describe("effectivePlan", () => {
  it("uses the account plan while logged in and running", () => {
    const account: Entitlement = { ...MONTHLY, expiresAt: future };
    expect(effectivePlan("authed", account, [FREE, MONTHLY]).id).toBe(
      "monthly",
    );
  });
  it("drops to Free when a monthly plan has lapsed, and for guests", () => {
    const lapsed: Entitlement = { ...MONTHLY, expiresAt: past };
    expect(effectivePlan("authed", lapsed, [FREE, MONTHLY]).kind).toBe("free");
    expect(
      effectivePlan("guest", { ...LIFETIME, expiresAt: null }, [FREE]).kind,
    ).toBe("free");
  });
  it("takes the Free limits from the server list the admin edits", () => {
    const tweaked = plan({ maxTablesPerDiagram: 10 });
    expect(
      effectivePlan("guest", { ...FREE, expiresAt: null }, [tweaked])
        .maxTablesPerDiagram,
    ).toBe(10);
  });
});

describe("comparison table", () => {
  it("has one cell per plan in every row", () => {
    const plans = [FREE, MONTHLY, LIFETIME];
    for (const row of comparisonRows(plans))
      expect(row.cells).toHaveLength(plans.length);
  });
  it('shows the limits from the plans and "Unlimited" with the online numbers for a local copy', () => {
    const [diagrams, tables] = comparisonRows([FREE, MONTHLY, LIFETIME]);
    expect(diagrams.cells).toEqual(["1", "5", "Unlimited"]);
    expect(tables.cells).toEqual(["25", "100", "Unlimited"]);
    expect(tables.notes?.[2]).toBe("500 in your online account");
  });
});
