import { Agent } from "agents";
import { invariant } from "@durable-harness/core";
import type { DemoEnv } from "./protocol.js";

export interface SupplierOffer {
  supplier: string;
  unitPrice: number;
  freight: number;
  quantity: number;
  leadDays: number;
}
interface Verification {
  supplier: string;
  materials: number;
  freight: number;
  total: number;
  evidence: "synthetic";
}
/** A deterministic reference agent with durable, idempotent task results. */
export class SupplierAgent extends Agent<
  DemoEnv,
  { tasks: Record<string, { input: string; result: Verification }> }
> {
  initialState = { tasks: {} };
  async verify(id: string, offer: SupplierOffer): Promise<Verification> {
    const input = JSON.stringify(offer);
    const previous = this.state.tasks[id];
    if (previous) {
      invariant(
        previous.input === input,
        "REPLAY_DIVERGENCE",
        "This supplier task already has different inputs.",
      );
      return previous.result;
    }
    invariant(
      offer.quantity > 0 &&
        Number.isSafeInteger(offer.quantity) &&
        [offer.unitPrice, offer.freight, offer.leadDays].every(
          (value) => Number.isFinite(value) && value >= 0,
        ),
      "INVALID_INPUT",
      "Supplier verification requires valid prices, quantity, and lead time.",
    );
    const result: Verification = {
      supplier: offer.supplier,
      materials: offer.unitPrice * offer.quantity,
      freight: offer.freight,
      total: offer.unitPrice * offer.quantity + offer.freight,
      evidence: "synthetic",
    };
    this.setState({ tasks: { ...this.state.tasks, [id]: { input, result } } });
    return result;
  }
}
