import type { EvaluationCase } from "@durable-harness/core";

export interface Offer {
  supplier: string;
  unitPrice: number;
  currency: string;
  freight: number;
  packSize: number;
  minimumPacks: number;
}
export interface QuoteInput {
  quantity: number;
  rates: Record<string, number>;
  policy: { includeFreight: boolean; allowOverbuy: boolean };
  offers: Offer[];
}
export const toolContract = (
  stage: 1 | 2,
) => `Implement pure JavaScript function rankOffers(input). You may add named helper functions. No imports, network, globals, or captured workspace state.
Input: {quantity:number, rates:Record<string,number>, policy:{includeFreight:boolean,allowOverbuy:boolean}, offers:Array<{supplier:string,unitPrice:number,currency:string,freight:number,packSize:number,minimumPacks:number}>}.
rates maps each currency to USD per currency unit. ${stage === 1 ? "Schema v1: unitPrice is per unit; packSize and minimumPacks are both 1." : "Schema v2: unitPrice is the price of one pack. Order whole packs, respecting minimumPacks. If allowOverbuy is false, exclude offers that would deliver more than quantity."} freight is per order in that offer's currency. Respect includeFreight independently for every customer. Exclude offers with absent/nonpositive exchange rates. Rank by USD total, breaking equal totals by supplier name ascending. Return {supplier:string|null,totalUsd:number|null,approvalRequired:true}, rounding only the final USD total to cents. With no eligible offers return null supplier/total. Never mutate input. This tool only recommends; it cannot authorize or send orders.`;

export const seedTool = `function rankOffers(input) {
  const best = [...input.offers].sort((a,b) => a.unitPrice-b.unitPrice)[0];
  return {supplier: best ? best.supplier : null, totalUsd: best ? best.unitPrice*input.quantity : null, approvalRequired:true};
}`;

export const corrections = {
  1: [
    "The recommendation compared a euro offer directly with a dollar offer. We need a currency-normalizing quote tool using the supplied rates, including freight when that customer's policy requests it.",
    "A customer who excludes freight must keep that preference. An unavailable rate is not permission to assume parity or to skip approval.",
  ],
  2: [
    "The supplier prices are per pack, not per unit. The last recommendation also ignored the minimum order. Compute the packs we actually have to buy.",
    "Customers who disallow surplus must not get overbuy recommendations. Preserve the existing currency, freight, and approval behavior; tied offers should be deterministic.",
  ],
} as const;

const offer = (
  supplier: string,
  unitPrice: number,
  freight = 0,
  currency = "USD",
  packSize = 1,
  minimumPacks = 1,
): Offer => ({ supplier, unitPrice, freight, currency, packSize, minimumPacks });
const input = (
  quantity: number,
  offers: Offer[],
  overrides: Partial<QuoteInput> = {},
): QuoteInput => ({
  quantity,
  offers,
  rates: { USD: 1, EUR: 1.2, GBP: 1.5 },
  policy: { includeFreight: true, allowOverbuy: true },
  ...overrides,
});
const expected = (supplier: string | null, totalUsd: number | null) => ({
  supplier,
  totalUsd,
  approvalRequired: true,
});
type Scenario = [string, QuoteInput, ReturnType<typeof expected>];

// Hand-authored outcomes, separate from the candidate's arithmetic. Each scenario is
// assigned once; the sealed assessment endpoint never returns its inputs or answers.
const stages: Record<1 | 2, Record<EvaluationCase["split"], Scenario[]>> = {
  1: {
    adaptation: [
      [
        "harbor-freight",
        input(10, [offer("Harbor", 9, 30), offer("Meadow", 11)]),
        expected("Meadow", 110),
      ],
      [
        "euro-conversion",
        input(10, [offer("Orchard", 9, 0, "EUR"), offer("Pine", 10)]),
        expected("Pine", 100),
      ],
      [
        "cedar-policy",
        input(10, [offer("Lake", 8, 60), offer("Ridge", 10)], {
          policy: { includeFreight: false, allowOverbuy: true },
        }),
        expected("Lake", 80),
      ],
      ["unpriced-currency", input(3, [offer("Stone", 1, 0, "CAD")]), expected(null, null)],
    ],
    validation: [
      ["freight-reversal", input(5, [offer("Elm", 7, 20), offer("Fir", 10)]), expected("Fir", 50)],
      [
        "pound-order",
        input(4, [offer("Grove", 5, 2, "GBP"), offer("Hill", 8)]),
        expected("Hill", 32),
      ],
      [
        "excluded-freight",
        input(6, [offer("Iron", 4, 100), offer("Juniper", 6)], {
          policy: { includeFreight: false, allowOverbuy: true },
        }),
        expected("Iron", 24),
      ],
      [
        "missing-and-valid",
        input(2, [offer("Knoll", 1, 0, "CAD"), offer("Linden", 9)]),
        expected("Linden", 18),
      ],
    ],
    heldout: [
      [
        "expensive-delivery",
        input(9, [offer("Moss", 3, 30), offer("Nook", 5)]),
        expected("Nook", 45),
      ],
      [
        "cheap-import",
        input(7, [offer("Oak", 5, 3, "EUR"), offer("Park", 7)]),
        expected("Oak", 45.6),
      ],
      ["no-rate", input(8, [offer("Quartz", 4, 0, "JPY")]), expected(null, null)],
      [
        "zero-rate",
        input(2, [offer("Reed", 1), offer("Spruce", 2, 0, "EUR")], {
          rates: { USD: 0, EUR: 1.25 },
        }),
        expected("Spruce", 5),
      ],
      [
        "customer-exclusion",
        input(3, [offer("Thorn", 2, 40), offer("Upland", 4)], {
          policy: { includeFreight: false, allowOverbuy: true },
        }),
        expected("Thorn", 6),
      ],
      [
        "fractional-rate",
        input(2, [offer("Vale", 3, 1, "EUR")], { rates: { EUR: 1.234 } }),
        expected("Vale", 8.64),
      ],
    ],
  },
  2: {
    adaptation: [
      [
        "carton-price",
        input(12, [offer("Alder", 30, 0, "USD", 6), offer("Birch", 6)]),
        expected("Alder", 60),
      ],
      [
        "minimum-order",
        input(5, [offer("Copper", 2, 0, "USD", 1, 20), offer("Delta", 5)]),
        expected("Delta", 25),
      ],
      [
        "exact-quantity",
        input(7, [offer("Estuary", 8, 0, "USD", 4), offer("Field", 3)], {
          policy: { includeFreight: true, allowOverbuy: false },
        }),
        expected("Field", 21),
      ],
      ["tie-rule", input(2, [offer("Zenith", 5), offer("Acorn", 5)]), expected("Acorn", 10)],
    ],
    validation: [
      [
        "whole-cartons",
        input(11, [offer("Bay", 18, 0, "USD", 5), offer("Cove", 6)]),
        expected("Bay", 54),
      ],
      [
        "minimum-cartons",
        input(4, [offer("Dune", 5, 0, "USD", 2, 6), offer("Edge", 6)]),
        expected("Edge", 24),
      ],
      [
        "reject-all-surplus",
        input(5, [offer("Fern", 2, 0, "USD", 3)], {
          policy: { includeFreight: true, allowOverbuy: false },
        }),
        expected(null, null),
      ],
      ["tie-order", input(3, [offer("Zephyr", 7), offer("Arc", 7)]), expected("Arc", 21)],
    ],
    heldout: [
      [
        "import-carton",
        input(13, [offer("Brook", 20, 4, "EUR", 6), offer("Creek", 6)]),
        expected("Brook", 76.8),
      ],
      [
        "minimum-freight",
        input(8, [offer("Dell", 12, 4, "GBP", 4, 3), offer("Eave", 7)]),
        expected("Eave", 56),
      ],
      [
        "surplus-blocked",
        input(9, [offer("Flint", 9, 0, "USD", 5), offer("Glen", 4)], {
          policy: { includeFreight: true, allowOverbuy: false },
        }),
        expected("Glen", 36),
      ],
      [
        "carton-policy",
        input(10, [offer("Heath", 12, 200, "USD", 5), offer("Inlet", 4)], {
          policy: { includeFreight: false, allowOverbuy: true },
        }),
        expected("Heath", 24),
      ],
      [
        "minimum-surplus",
        input(6, [offer("Jetty", 1, 0, "USD", 2, 4)], {
          policy: { includeFreight: true, allowOverbuy: false },
        }),
        expected(null, null),
      ],
      [
        "carton-tie",
        input(8, [offer("Zinc", 8, 0, "USD", 2), offer("Ash", 16, 0, "USD", 4)]),
        expected("Ash", 32),
      ],
    ],
  },
};

export function procurementCases(stage: 1 | 2): EvaluationCase[] {
  const result: EvaluationCase[] = [];
  for (const current of [1, 2] as const) {
    if (current > stage) break;
    for (const split of ["adaptation", "validation", "heldout"] as const)
      for (const [id, input, expected] of stages[current][split])
        result.push({
          id,
          family: id,
          split,
          input,
          expected,
          ...(split === "validation" ? { critical: true } : {}),
        });
  }
  return result;
}
