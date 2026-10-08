import { CircleCheck, Clock, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/auth/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPrice, priceParts, type PlanInfo } from "../plans";

/** An order as the server sends it to its buyer. */
export type Order = {
  id: string;
  planId: string;
  planName: string;
  planKind: string;
  status: "pending" | "paid" | "cancelled";
  amountCents: number;
  currency: string;
  contact: string;
  reference: string;
  createdAt: string;
  paidAt: string | null;
};

type Placed = { order: Order; instructions: string };

/**
 * Buying a plan, in two steps in one dialog: confirm (what it costs, and for the lifetime copy how to reach you), then the
 * placed order with the payment instructions and a box for your payment reference. Nothing is charged by the app: the plan
 * starts when the payment has been confirmed, which is shown on the pricing page.
 *
 * Opened with a `plan` it starts at "confirm" (and shows the open order straight away if there already is one); opened
 * with an `existing` order it starts at the payment instructions.
 */
export function CheckoutDialog({
  plan,
  existing,
  onClose,
  onChanged,
}: {
  plan: PlanInfo | null;
  existing: Placed | null;
  onClose: () => void;
  /** Something about the orders changed (placed, updated, cancelled): the page should reload them. */
  onChanged: () => void;
}) {
  const [placed, setPlaced] = useState<Placed | null>(existing);
  const [contact, setContact] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState<"place" | "save" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const open = plan !== null || existing !== null;

  // A different order / plan was opened: start from its own state.
  useEffect(() => {
    setPlaced(existing);
    setContact(existing?.order.contact ?? "");
    setReference(existing?.order.reference ?? "");
    setError(null);
    setSaved(false);
  }, [existing, plan]);

  const shown =
    plan ??
    (existing &&
      ({
        id: existing.order.planId,
        name: existing.order.planName,
        kind: existing.order.planKind,
      } as PlanInfo));
  const isLifetime = shown?.kind === "lifetime";

  const run = async (
    kind: "place" | "save" | "cancel",
    work: () => Promise<void>,
  ) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      setBusy(null);
    }
  };

  const place = () =>
    run("place", async () => {
      const result = await api<Placed>("/orders", {
        body: { planId: plan!.id, contact: contact.trim() || undefined },
      });
      setPlaced(result);
      setReference(result.order.reference);
      onChanged();
    });

  const saveReference = () =>
    run("save", async () => {
      const { order } = await api<{ order: Order }>(
        `/orders/${placed!.order.id}`,
        {
          method: "PUT",
          body: { reference: reference.trim(), contact: contact.trim() },
        },
      );
      setPlaced((p) => (p ? { ...p, order } : p));
      setSaved(true);
      onChanged();
    });

  const cancel = () =>
    run("cancel", async () => {
      await api(`/orders/${placed!.order.id}/cancel`, {
        method: "POST",
        body: {},
      });
      onChanged();
      onClose();
    });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="font-ui max-w-md gap-5">
        {!placed ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {plan ? `Get the ${plan.name} plan` : ""}
              </DialogTitle>
              <DialogDescription>
                {plan
                  ? `${priceParts(plan).amount} ${priceParts(plan).period}`.trim()
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <p className="text-[13.5px] leading-relaxed text-muted">
              We will show you how to pay on the next step. Your plan starts as
              soon as the payment has been confirmed.
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="checkout-contact">
                {isLifetime
                  ? "Phone or WhatsApp"
                  : "Phone or WhatsApp (optional)"}
              </Label>
              <Input
                id="checkout-contact"
                value={contact}
                maxLength={120}
                onChange={(e) => setContact(e.target.value)}
                placeholder="+92 300 1234567"
                autoComplete="tel"
              />
              {isLifetime && (
                <p className="text-[12.5px] text-muted">
                  We will use it to set up your own copy and run it for you.
                </p>
              )}
            </div>
            {error && (
              <p role="alert" className="text-[13px] text-danger">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={onClose}
                className="cursor-pointer"
              >
                Not now
              </Button>
              <Button
                onClick={place}
                disabled={busy !== null || (isLifetime && !contact.trim())}
                className="cursor-pointer"
              >
                {busy === "place" && <LoaderCircle className="animate-spin" />}
                Place order
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {placed.order.status === "paid" ? (
                  <CircleCheck className="text-ok" size={20} />
                ) : (
                  <Clock className="text-warning" size={20} />
                )}
                {placed.order.status === "paid"
                  ? "Paid. Your plan is active"
                  : placed.order.status === "cancelled"
                    ? "Order cancelled"
                    : "Order placed"}
              </DialogTitle>
              <DialogDescription>
                {placed.order.planName} ·{" "}
                {placed.order.amountCents === 0
                  ? "Free"
                  : formatPrice(
                      placed.order.amountCents,
                      placed.order.currency,
                    )}
              </DialogDescription>
            </DialogHeader>

            {placed.order.status === "pending" && (
              <>
                <div className="grid gap-1.5">
                  <p className="text-[12px] font-semibold tracking-wider text-muted uppercase">
                    How to pay
                  </p>
                  <div className="rounded-lg border border-line bg-canvas p-3 text-[13.5px] leading-relaxed whitespace-pre-wrap">
                    {placed.instructions}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="checkout-reference">
                    Your payment reference
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="checkout-reference"
                      value={reference}
                      maxLength={200}
                      onChange={(e) => {
                        setReference(e.target.value);
                        setSaved(false);
                      }}
                      placeholder="Transaction id, or the name on the transfer"
                    />
                    <Button
                      variant="outline"
                      onClick={saveReference}
                      disabled={busy !== null}
                      className="cursor-pointer"
                    >
                      {busy === "save" ? (
                        <LoaderCircle className="animate-spin" />
                      ) : saved ? (
                        "Saved"
                      ) : (
                        "Save"
                      )}
                    </Button>
                  </div>
                  <p className="text-[12.5px] text-muted">
                    This helps us match your payment. We confirm it by hand,
                    then your plan starts and this page updates by itself.
                  </p>
                </div>
              </>
            )}
            {placed.order.status === "paid" && (
              <p className="text-[13.5px] leading-relaxed text-muted">
                Thank you.{" "}
                {isLifetime
                  ? "We will contact you to set up your copy."
                  : "Everything in the plan is unlocked."}
              </p>
            )}
            {error && (
              <p role="alert" className="text-[13px] text-danger">
                {error}
              </p>
            )}
            <DialogFooter className="sm:justify-between">
              {placed.order.status === "pending" ? (
                <Button
                  variant="ghost"
                  onClick={cancel}
                  disabled={busy !== null}
                  className="cursor-pointer text-danger hover:text-danger"
                >
                  {busy === "cancel" && (
                    <LoaderCircle className="animate-spin" />
                  )}
                  Cancel order
                </Button>
              ) : (
                <span />
              )}
              <Button onClick={onClose} className="cursor-pointer">
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
