import { ArrowLeft, Check, Minus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/auth/api";
import { useAuth } from "@/auth/store";
import { CheckoutDialog, type Order } from "@/components/CheckoutDialog";
import { Button } from "@/components/ui/button";
import { APP_PATH, link, navigate } from "@/lib/route";
import { useEffectivePlan } from "../planHooks";
import {
  comparisonRows,
  formatDate,
  priceParts,
  type PlanInfo,
} from "../plans";
import { usePlans } from "../plansStore";

/**
 * /pricing: the plans side by side (cards, then a table of everything each one includes) and, for a signed-in user, the
 * way to buy one. Prices and limits all come from the server, where the admin edits them.
 */

const STATUS_TEXT: Record<Order["status"], string> = {
  pending: "Waiting for payment",
  paid: "Paid",
  cancelled: "Cancelled",
};

export function PricingPage() {
  const plans = usePlans((s) => s.plans);
  const loadStatus = usePlans((s) => s.status);
  const status = useAuth((s) => s.status);
  const current = useEffectivePlan();
  const [target, setTarget] = useState<PlanInfo | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [instructions, setInstructions] = useState("");
  const [openOrder, setOpenOrder] = useState<Order | null>(null);
  const authed = status === "authed";

  useEffect(() => {
    void usePlans.getState().load(true);
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const res = await api<{ orders: Order[]; instructions: string }>(
        "/orders",
      );
      setOrders(res.orders);
      setInstructions(res.instructions);
    } catch {
      /* the list is a convenience: the page works without it */
    }
  }, []);

  // The account's orders; polled while one waits for payment, so the plan shows up here as soon as the admin confirms it.
  const waiting = orders.some((o) => o.status === "pending");
  useEffect(() => {
    if (!authed) return;
    void loadOrders();
  }, [authed, loadOrders]);
  useEffect(() => {
    if (!authed || !waiting) return;
    const timer = window.setInterval(() => {
      void loadOrders();
      void useAuth.getState().refreshPlan();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [authed, waiting, loadOrders]);

  const rows = comparisonRows(plans);
  const buy = (plan: PlanInfo) => {
    if (!authed) {
      navigate(APP_PATH); // sign in first; the pricing page is one click away afterwards
      return;
    }
    const open = orders.find(
      (o) => o.planId === plan.id && o.status === "pending",
    );
    if (open) setOpenOrder(open);
    else setTarget(plan);
  };

  const cta = (plan: PlanInfo) => {
    if (plan.kind === "free")
      return current.kind === "free" ? "Your plan" : null;
    if (current.kind === "lifetime")
      return plan.id === current.id ? "Your plan" : null;
    if (plan.id === current.id) return "Renew";
    return orders.some((o) => o.planId === plan.id && o.status === "pending")
      ? "Finish payment"
      : "Get " + plan.name;
  };

  return (
    <div className="min-h-full bg-canvas font-ui text-ink">
      <header className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-5">
        <a
          href={authed || status === "guest" ? APP_PATH : "/"}
          onClick={link(authed || status === "guest" ? APP_PATH : "/")}
          className="flex items-center gap-2 text-[13.5px] text-muted hover:text-ink"
        >
          <ArrowLeft size={16} /> Back
        </a>
        <span className="ml-auto font-semibold">
          <span className="text-key">erd</span>
          <span className="text-muted">.designer</span>
        </span>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-20">
        <h1 className="text-3xl font-semibold tracking-tight">
          Plans and pricing
        </h1>
        <p className="mt-2 max-w-xl text-[15px] text-muted">
          Start free. Pay only when you need more diagrams, bigger diagrams or
          the extras.
          {authed && current.kind === "monthly" && current.expiresAt && (
            <>
              {" "}
              Your {current.name} plan runs until{" "}
              {formatDate(current.expiresAt)}.
            </>
          )}
        </p>

        {loadStatus === "error" && plans.length === 0 && (
          <p role="alert" className="mt-8 text-danger">
            Could not load the plans. Check your connection and refresh.
          </p>
        )}

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {plans.map((plan) => {
            const price = priceParts(plan);
            const label = cta(plan);
            const featured = plan.kind === "monthly";
            return (
              <section
                key={plan.id}
                className={`flex flex-col rounded-2xl border bg-surface p-6 ${featured ? "border-key" : "border-line"}`}
              >
                <h2 className="text-lg font-semibold">{plan.name}</h2>
                <p className="mt-1 min-h-10 text-[13.5px] text-muted">
                  {plan.description}
                </p>
                <p className="mt-4 flex items-baseline gap-1.5">
                  <span className="text-4xl font-semibold tracking-tight">
                    {price.amount}
                  </span>
                  <span className="text-[13px] text-muted">{price.period}</span>
                </p>
                <ul className="mt-5 flex-1 space-y-2 text-[13.5px]">
                  {plan.highlights.map((h) => (
                    <li key={h} className="flex gap-2">
                      <Check
                        size={16}
                        className="mt-0.5 shrink-0 text-ok"
                        aria-hidden
                      />
                      {h}
                    </li>
                  ))}
                </ul>
                {label &&
                  (label === "Your plan" ? (
                    <p className="mt-6 text-center text-[13.5px] font-medium text-muted">
                      Your plan
                    </p>
                  ) : (
                    <Button
                      onClick={() => buy(plan)}
                      variant={featured ? "default" : "outline"}
                      className="mt-6 h-10 cursor-pointer"
                    >
                      {label}
                    </Button>
                  ))}
                {!authed && plan.kind !== "free" && (
                  <p className="mt-2 text-center text-[12px] text-muted">
                    You will sign in first
                  </p>
                )}
              </section>
            );
          })}
        </div>

        {plans.length > 0 && (
          <div className="mt-12 overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full min-w-[560px] border-collapse text-left text-[13.5px]">
              <caption className="sr-only">What each plan includes</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="p-4 font-medium text-muted">
                    What you get
                  </th>
                  {plans.map((p) => (
                    <th key={p.id} scope="col" className="p-4 font-semibold">
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.label}
                    className="border-b border-line last:border-0"
                  >
                    <th scope="row" className="p-4 font-normal">
                      {row.label}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td key={plans[i].id} className="p-4">
                        {typeof cell === "boolean" ? (
                          cell ? (
                            <Check
                              size={17}
                              className="text-ok"
                              aria-label="Included"
                            />
                          ) : (
                            <Minus
                              size={17}
                              className="text-muted"
                              aria-label="Not included"
                            />
                          )
                        ) : (
                          <>
                            {cell}
                            {row.notes?.[i] && (
                              <span className="block text-[12px] text-muted">
                                {row.notes[i]}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {authed && orders.length > 0 && (
          <section className="mt-12">
            <h2 className="text-lg font-semibold">Your orders</h2>
            <ul className="mt-3 divide-y divide-line rounded-2xl border border-line bg-surface">
              {orders.map((o) => (
                <li
                  key={o.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-[13.5px]"
                >
                  <span className="font-medium">{o.planName}</span>
                  <span className="text-muted">
                    {new Date(o.createdAt).toLocaleDateString("en")}
                  </span>
                  <span
                    className={
                      o.status === "paid"
                        ? "text-ok"
                        : o.status === "pending"
                          ? "text-warning"
                          : "text-muted"
                    }
                  >
                    {STATUS_TEXT[o.status]}
                  </span>
                  {o.status === "pending" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto cursor-pointer"
                      onClick={() => setOpenOrder(o)}
                    >
                      Payment details
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <CheckoutDialog
        plan={target}
        existing={openOrder ? { order: openOrder, instructions } : null}
        onClose={() => {
          setTarget(null);
          setOpenOrder(null);
        }}
        onChanged={() => {
          void loadOrders();
          void useAuth.getState().refreshPlan();
        }}
      />
    </div>
  );
}
