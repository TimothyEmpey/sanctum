import type { Contract, Direction } from "./types";

/** Contract for a future approved adapter. No vendor endpoints or credentials are guessed. */
export type OrderIntent = { id: string; accountId: string; contract: Contract; direction: Direction; quantity: number; stop: number; targets: number[] };
export type OrderStatus = "PENDING" | "UNKNOWN" | "ACCEPTED" | "PARTIAL" | "FILLED" | "CANCELED" | "REJECTED";
export interface ExecutionAdapter {
  readonly capabilities: { nativeProtection: boolean; live: boolean };
  submit(intent: OrderIntent): Promise<{ orderId: string; status: OrderStatus }>;
  reconcile(intentId: string): Promise<{ status: OrderStatus; filledQuantity: number; protectedQuantity: number }>;
  cancel(orderId: string): Promise<void>;
  flatten(accountId: string): Promise<void>;
}
export function externalAdapter(): never {
  throw new Error("No funded execution adapter is enabled. Firm approval, documented API entitlement, credentials and separate connection authorization are required.");
}

/** Reserve risk until the broker definitively resolves uncertain or partially filled orders. */
export function orderCanReleaseReservation(status:OrderStatus,filledQuantity:number,positionReconciled:boolean) {
  return (status==="REJECTED" || status==="CANCELED") && filledQuantity===0 && positionReconciled;
}
