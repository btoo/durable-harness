import {
  invariant,
  type LearningTarget,
  type Principal,
  type RecordStore,
  type ToolDefinition,
} from "@durable-harness/core";

export const DEMO_DEPLOYMENT = "synthetic";
export const operator: Principal = {
  id: "developer",
  roles: ["developer"],
  deploymentId: DEMO_DEPLOYMENT,
};
export const workspaces = [
  {
    id: "northstar-po",
    tenant: "Northstar Supply",
    kind: "po",
    label: "Purchase orders",
    subject: "PO-1042 · Delivery confirmation",
  },
  {
    id: "northstar-quoting",
    tenant: "Northstar Supply",
    kind: "quoting",
    label: "Supplier quotes",
    subject: "RFQ-208 · Precision housings",
  },
  {
    id: "cedar-quoting",
    tenant: "Cedar Manufacturing",
    kind: "quoting",
    label: "Supplier quotes",
    subject: "RFQ-315 · Mounting brackets",
  },
] as const;
export interface ProcurementPreferences {
  includeFreight: boolean;
  businessDaysOnly: boolean;
  approvalRequired: true;
}
export const initialPreferences: ProcurementPreferences = {
  includeFreight: false,
  businessDaysOnly: false,
  approvalRequired: true,
};
export interface Offer {
  supplier: string;
  unitPrice: number;
  freight: number;
  quantity: number;
  leadDays: number;
}
export const offers: Offer[] = [
  { supplier: "Aster Components", unitPrice: 12.4, freight: 180, quantity: 100, leadDays: 10 },
  { supplier: "Brookfield Parts", unitPrice: 13.2, freight: 30, quantity: 100, leadDays: 8 },
];
export function chooseOffer(offers: Offer[], preferences: ProcurementPreferences): Offer {
  return [...offers].sort(
    (a, b) =>
      a.unitPrice * a.quantity +
      (preferences.includeFreight ? a.freight : 0) -
      (b.unitPrice * b.quantity + (preferences.includeFreight ? b.freight : 0)),
  )[0]!;
}
export function followupDate(iso: string, preferences: ProcurementPreferences): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + 2);
  if (preferences.businessDaysOnly)
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
export function preferencesTarget(): LearningTarget {
  return {
    name: "procurement-preferences",
    kind: "instruction",
    validate(candidate) {
      const value = candidate as ProcurementPreferences;
      invariant(
        value &&
          typeof value.includeFreight === "boolean" &&
          typeof value.businessDaysOnly === "boolean" &&
          value.approvalRequired === true &&
          Object.keys(value).every((key) => Object.keys(initialPreferences).includes(key)),
        "INVALID_INPUT",
        "Preferences may change quote comparison and reminder timing. Business actions must retain approval.",
      );
    },
    evaluator: {
      id: "procurement-behavior-v1",
      async evaluate({ configuration, testCase }) {
        const preferences = configuration as ProcurementPreferences;
        const input = testCase.input as { offers?: Offer[]; date?: string };
        const actual = input.offers
          ? chooseOffer(input.offers, preferences).supplier
          : input.date
            ? followupDate(input.date, preferences)
            : preferences.approvalRequired;
        const passed = actual === testCase.expected;
        return {
          caseId: testCase.id,
          passed,
          score: Number(passed),
          explanation: `Observed ${JSON.stringify(actual)}; expected ${JSON.stringify(testCase.expected)}.`,
        };
      },
    },
    cases: [
      {
        id: "freight-inclusive",
        family: "freight-1",
        split: "validation",
        input: { offers },
        expected: "Brookfield Parts",
      },
      {
        id: "weekend-reminder",
        family: "weekend-1",
        split: "validation",
        input: { date: "2026-09-04T10:00:00Z" },
        expected: "2026-09-07",
      },
      {
        id: "approval-boundary",
        family: "approval-1",
        split: "validation",
        input: {},
        expected: true,
        critical: true,
      },
      {
        id: "weekday-reminder",
        family: "weekday-2",
        split: "heldout",
        input: { date: "2026-09-07T10:00:00Z" },
        expected: "2026-09-09",
      },
    ],
  };
}

export function domainTools(store: RecordStore): ToolDefinition[] {
  return workspaces.flatMap((workspace) => {
    const common = {
      version: "1",
      spaceId: workspace.id,
      inputSchema: { type: "object", additionalProperties: false },
    };
    return [
      {
        ...common,
        name: `${workspace.id}.read`,
        description: `Read synthetic ${workspace.kind} evidence for ${workspace.tenant}.`,
        effect: "read" as const,
        publicActivity:
          workspace.kind === "po"
            ? "Checking the purchase order and supplier reply"
            : "Reading the supplier quotes",
        execute: async () =>
          workspace.kind === "po"
            ? {
                order: "PO-1042",
                promisedDate: "2026-09-11",
                supplier: "Aster Components",
                supplierReply: "The materials are ready. We can confirm dispatch after approval.",
                receivedAt: "2026-09-04T10:00:00Z",
              }
            : { rfq: workspace.subject.split(" · ")[0], offers },
      },
      {
        ...common,
        name: `${workspace.id}.preferences`,
        description: "Read the current evaluated customer preferences.",
        effect: "read" as const,
        publicActivity: "Applying your saved preferences",
        execute: async () =>
          store.get<{ value: ProcurementPreferences }>(
            "configuration",
            `${workspace.id}:procurement-preferences`,
          )?.value ?? initialPreferences,
      },
      {
        ...common,
        name: `${workspace.id}.send`,
        description: "Send an approved message through the synthetic supplier system.",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string", maxLength: 200 },
            body: { type: "string", maxLength: 4000 },
          },
          required: ["subject", "body"],
          additionalProperties: false,
        },
        effect: "external" as const,
        requiresApproval: true,
        publicActivity: "Sending your approved supplier message",
        execute: async (input, context) => {
          const existing = store.get("synthetic_deliveries", context.operationId);
          if (existing) return existing;
          const receipt = {
            id: context.operationId,
            status: "delivered",
            provider: "synthetic-mail",
            ...(input as object),
          };
          store.put("synthetic_deliveries", context.operationId, receipt);
          return receipt;
        },
        reconcile: async (operationId) => {
          const result = store.get("synthetic_deliveries", operationId);
          return { found: !!result, result };
        },
      },
    ];
  });
}

export function scenarioSource(workspaceId: string): string {
  const workspace = workspaces.find((item) => item.id === workspaceId)!;
  return workspace.kind === "po"
    ? `
const order = await tools.call("${workspaceId}.read", {});
const preferences = await tools.call("${workspaceId}.preferences", {});
function nextFollowup(iso: string, weekdays: boolean) { const date = new Date(iso); date.setUTCDate(date.getUTCDate() + 2); if (weekdays) while ([0,6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0,10); }
const followup = {order: order.order, date: nextFollowup(order.receivedAt, preferences.businessDaysOnly), status: "proposed"};
await runtime.progress("The supplier is ready to dispatch. The next follow-up is scheduled for " + followup.date + ".");
`
    : `
const evidence = await tools.call("${workspaceId}.read", {});
const preferences = await tools.call("${workspaceId}.preferences", {});
function rankOffers(items: {unitPrice:number,freight:number,quantity:number}[], includeFreight: boolean) { return [...items].sort((a,b) => (a.unitPrice*a.quantity+(includeFreight?a.freight:0))-(b.unitPrice*b.quantity+(includeFreight?b.freight:0))); }
const comparison = {rfq: evidence.rfq, offers: rankOffers(evidence.offers, preferences.includeFreight), includesFreight: preferences.includeFreight};
const recommendation = comparison.offers[0];
await runtime.progress(recommendation.supplier + " is the lowest-cost option " + (preferences.includeFreight ? "including freight." : "before freight."));
`;
}
