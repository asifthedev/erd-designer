import { LoaderCircle } from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, ApiError } from "@/auth/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  formatDate,
  formatPrice,
  type PlanInfo,
} from "../plans";

/**
 * /admin: its own login (the admin account is set on the server, not in the user table) and a panel with the numbers,
 * the plans and their prices, the registered users, the orders and the payment instructions.
 * Everything goes through /api/admin and only works with the admin cookie.
 */

type AdminPlan = PlanInfo & { active: boolean };
type Overview = {
  users: number;
  newUsers: number;
  usersByPlan: { planId: string; count: number }[];
  pendingOrders: number;
  paidOrders: number;
  revenue: { currency: string; cents: number }[];
};
type AdminUser = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  planId: string;
  planName: string;
  planExpiresAt: string | null;
  planExpired: boolean;
  diagrams: number;
};
type AdminOrder = {
  id: string;
  userEmail: string;
  planId: string;
  planName: string;
  planKind: string;
  status: "pending" | "paid" | "cancelled";
  amountCents: number;
  currency: string;
  contact: string;
  reference: string;
  adminNote: string;
  createdAt: string;
  paidAt: string | null;
};

const message = (e: unknown) =>
  e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
const card = "rounded-2xl border border-line bg-surface p-5";
const select =
  "h-9 rounded-md border border-line bg-canvas px-2 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-key";

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/admin/login", { body: { email, password } });
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center bg-canvas p-5 font-ui text-ink">
      <form onSubmit={submit} className={`${card} grid w-full max-w-sm gap-4`}>
        <h1 className="text-xl font-semibold">Admin sign in</h1>
        <div className="grid gap-1.5">
          <Label htmlFor="admin-email">Email</Label>
          <Input
            id="admin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="admin-password">Password</Label>
          <Input
            id="admin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="cursor-pointer">
          {busy && <LoaderCircle className="animate-spin" />}
          Sign in
        </Button>
      </form>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={card}>
      <p className="text-[12px] font-semibold tracking-wider text-muted uppercase">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function OverviewTab({ plans }: { plans: AdminPlan[] }) {
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => {
    void api<Overview>("/admin/overview")
      .then(setData)
      .catch(() => undefined);
  }, []);
  if (!data) return <p className="text-muted">Loading…</p>;
  const name = (id: string) => plans.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Registered users" value={data.users} />
        <Stat label="New in 7 days" value={data.newUsers} />
        <Stat label="Orders waiting" value={data.pendingOrders} />
        <Stat
          label="Paid revenue"
          value={
            data.revenue.length
              ? data.revenue
                  .map((r) => formatPrice(r.cents, r.currency))
                  .join(" + ")
              : "—"
          }
        />
      </div>
      <div className={card}>
        <h2 className="font-semibold">Users per plan</h2>
        <ul className="mt-2 text-[13.5px]">
          {data.usersByPlan.map((r) => (
            <li
              key={r.planId}
              className="flex justify-between border-b border-line py-1.5 last:border-0"
            >
              <span>{name(r.planId)}</span>
              <span className="text-muted">{r.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PlanEditor({
  plan,
  onSaved,
}: {
  plan: AdminPlan;
  onSaved: (p: AdminPlan) => void;
}) {
  const [draft, setDraft] = useState(() => ({
    name: plan.name,
    description: plan.description,
    price: String(plan.priceCents / 100),
    currency: plan.currency,
    maxDiagrams: String(plan.maxDiagrams),
    maxTablesPerDiagram: String(plan.maxTablesPerDiagram),
    highlights: plan.highlights.join("\n"),
    active: plan.active,
    features: plan.features,
  }));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setNote(null);
  };
  const isFree = plan.kind === "free";

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const { plan: saved } = await api<{ plan: AdminPlan }>(
        `/admin/plans/${plan.id}`,
        {
          method: "PUT",
          body: {
            name: draft.name,
            description: draft.description,
            priceCents: Math.round(Number(draft.price) * 100),
            currency: draft.currency,
            maxDiagrams: Number(draft.maxDiagrams),
            maxTablesPerDiagram: Number(draft.maxTablesPerDiagram),
            highlights: draft.highlights
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
            active: draft.active,
            features: draft.features,
          },
        },
      );
      onSaved(saved);
      setNote({ ok: true, text: "Saved. Visitors see it within 30 seconds." });
    } catch (e) {
      setNote({ ok: false, text: message(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${card} grid gap-4`}>
      <h2 className="flex items-center gap-2 font-semibold">
        {plan.name}
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-normal text-muted">
          {plan.kind}
        </span>
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Name</Label>
          <Input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            maxLength={40}
          />
        </div>
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <div className="grid gap-1.5">
            <Label>
              Price{" "}
              {plan.kind === "monthly"
                ? "(per month)"
                : plan.kind === "lifetime"
                  ? "(one time)"
                  : ""}
            </Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={draft.price}
              disabled={isFree}
              onChange={(e) => set("price", e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Currency</Label>
            <Input
              value={draft.currency}
              maxLength={3}
              disabled={isFree}
              onChange={(e) => set("currency", e.target.value.toUpperCase())}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label>Diagrams</Label>
          <Input
            type="number"
            min={1}
            value={draft.maxDiagrams}
            onChange={(e) => set("maxDiagrams", e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Tables per diagram</Label>
          <Input
            type="number"
            min={1}
            value={draft.maxTablesPerDiagram}
            onChange={(e) => set("maxTablesPerDiagram", e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label>Short description</Label>
        <Input
          value={draft.description}
          maxLength={200}
          onChange={(e) => set("description", e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Feature lines on the card (one per line)</Label>
        <Textarea
          rows={5}
          value={draft.highlights}
          onChange={(e) => set("highlights", e.target.value)}
        />
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-[13.5px] font-medium">
          Included features
        </legend>
        {FEATURE_KEYS.map((k) => (
          <label key={k} className="flex items-center gap-2 text-[13.5px]">
            <Checkbox
              checked={draft.features[k]}
              onCheckedChange={(v) =>
                set("features", { ...draft.features, [k]: v === true })
              }
            />
            {FEATURE_LABELS[k]}
          </label>
        ))}
      </fieldset>
      {!isFree && (
        <label className="flex items-center gap-2 text-[13.5px]">
          <Checkbox
            checked={draft.active}
            onCheckedChange={(v) => set("active", v === true)}
          />
          Show this plan on the pricing page
        </label>
      )}
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy} className="cursor-pointer">
          {busy && <LoaderCircle className="animate-spin" />}
          Save plan
        </Button>
        {note && (
          <p
            role="status"
            className={`text-[13px] ${note.ok ? "text-ok" : "text-danger"}`}
          >
            {note.text}
          </p>
        )}
      </div>
    </section>
  );
}

function PlansTab({
  plans,
  onChange,
}: {
  plans: AdminPlan[];
  onChange: (p: AdminPlan) => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {plans.map((p) => (
        <PlanEditor key={p.id} plan={p} onSaved={onChange} />
      ))}
    </div>
  );
}

function UsersTab({ plans }: { plans: AdminPlan[] }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{
    users: AdminUser[];
    total: number;
    pageSize: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(
        await api(`/admin/users?page=${page}&q=${encodeURIComponent(q)}`),
      );
    } catch (e) {
      setError(message(e));
    }
  }, [page, q]);
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(t);
  }, [load]);

  const setPlan = async (u: AdminUser, planId: string) => {
    if (
      !window.confirm(
        `Put ${u.email} on the ${plans.find((p) => p.id === planId)?.name} plan?`,
      )
    )
      return;
    try {
      await api(`/admin/users/${u.id}/plan`, {
        method: "PUT",
        body: { planId },
      });
      await load();
    } catch (e) {
      setError(message(e));
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <Input
          placeholder="Search name or email"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className="max-w-xs"
        />
        <span className="text-[13px] text-muted">
          {data ? `${data.total} users` : ""}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[640px] text-left text-[13.5px]">
          <thead>
            <tr className="border-b border-line text-muted">
              <th className="p-3 font-medium">User</th>
              <th className="p-3 font-medium">Joined</th>
              <th className="p-3 font-medium">Diagrams</th>
              <th className="p-3 font-medium">Plan</th>
            </tr>
          </thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.id} className="border-b border-line last:border-0">
                <td className="p-3">
                  <span className="block font-medium">{u.name || "—"}</span>
                  <span className="text-muted">{u.email}</span>
                </td>
                <td className="p-3 text-muted">{formatDate(u.createdAt)}</td>
                <td className="p-3">{u.diagrams}</td>
                <td className="p-3">
                  <select
                    aria-label={`Plan of ${u.email}`}
                    className={select}
                    value={u.planId}
                    onChange={(e) => void setPlan(u, e.target.value)}
                  >
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {u.planExpiresAt && (
                    <span
                      className={`ml-2 text-[12px] ${u.planExpired ? "text-danger" : "text-muted"}`}
                    >
                      {u.planExpired ? "ended" : "until"}{" "}
                      {formatDate(u.planExpiresAt)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-[13px]">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
          className="cursor-pointer"
        >
          Previous
        </Button>
        <span className="text-muted">
          Page {page} of {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => setPage(page + 1)}
          className="cursor-pointer"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function OrdersTab() {
  const [filter, setFilter] = useState<
    "pending" | "paid" | "cancelled" | "all"
  >("pending");
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(
        (await api<{ orders: AdminOrder[] }>(`/admin/orders?status=${filter}`))
          .orders,
      );
    } catch (e) {
      setError(message(e));
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (o: AdminOrder, kind: "paid" | "cancel") => {
    const text =
      kind === "paid"
        ? `Confirm the payment of ${formatPrice(o.amountCents, o.currency)} from ${o.userEmail}? The ${o.planName} plan starts now.`
        : `Cancel this order from ${o.userEmail}?`;
    if (!window.confirm(text)) return;
    try {
      await api(`/admin/orders/${o.id}/${kind}`, { body: {} });
      await load();
    } catch (e) {
      setError(message(e));
    }
  };
  const saveNote = async (o: AdminOrder, adminNote: string) => {
    if (adminNote === o.adminNote) return;
    try {
      await api(`/admin/orders/${o.id}`, {
        method: "PUT",
        body: { adminNote },
      });
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <div className="grid gap-3">
      <div className="flex gap-2">
        {(["pending", "paid", "cancelled", "all"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
            className="cursor-pointer capitalize"
          >
            {f}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      {orders.length === 0 && <p className="text-muted">No orders here.</p>}
      {orders.map((o) => (
        <div key={o.id} className={`${card} grid gap-3 text-[13.5px]`}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold">{o.planName}</span>
            <span>{formatPrice(o.amountCents, o.currency)}</span>
            <span className="text-muted">{o.userEmail}</span>
            <span className="text-muted">{formatDate(o.createdAt)}</span>
            <span
              className={
                o.status === "paid"
                  ? "text-ok"
                  : o.status === "pending"
                    ? "text-warning"
                    : "text-muted"
              }
            >
              {o.status}
            </span>
          </div>
          {(o.contact || o.reference) && (
            <p className="text-muted">
              {o.contact && (
                <>
                  Contact: <span className="text-ink">{o.contact}</span>
                </>
              )}
              {o.contact && o.reference && " · "}
              {o.reference && (
                <>
                  Reference: <span className="text-ink">{o.reference}</span>
                </>
              )}
            </p>
          )}
          <Input
            aria-label="Private note"
            placeholder="Private note"
            defaultValue={o.adminNote}
            maxLength={1000}
            onBlur={(e) => void saveNote(o, e.target.value.trim())}
          />
          {o.status === "pending" && (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void act(o, "paid")}
                className="cursor-pointer"
              >
                Mark as paid
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void act(o, "cancel")}
                className="cursor-pointer text-danger hover:text-danger"
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PaymentTab() {
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void api<{ paymentInstructions: string }>("/admin/settings").then((r) =>
      setText(r.paymentInstructions),
    );
  }, []);
  if (text === null) return <p className="text-muted">Loading…</p>;
  const save = async () => {
    try {
      const r = await api<{ paymentInstructions: string }>("/admin/settings", {
        method: "PUT",
        body: { paymentInstructions: text },
      });
      setText(r.paymentInstructions);
      setNote({ ok: true, text: "Saved." });
    } catch (e) {
      setNote({ ok: false, text: message(e) });
    }
  };
  return (
    <div className={`${card} grid max-w-2xl gap-3`}>
      <h2 className="font-semibold">How buyers pay</h2>
      <p className="text-[13.5px] text-muted">
        Shown to a buyer after they place an order: bank or wallet details, and
        where to send the receipt.
      </p>
      <Textarea
        rows={8}
        value={text}
        maxLength={4000}
        onChange={(e) => {
          setText(e.target.value);
          setNote(null);
        }}
      />
      <div className="flex items-center gap-3">
        <Button onClick={save} className="cursor-pointer">
          Save
        </Button>
        {note && (
          <p
            role="status"
            className={`text-[13px] ${note.ok ? "text-ok" : "text-danger"}`}
          >
            {note.text}
          </p>
        )}
      </div>
    </div>
  );
}

const TABS = [
  "Overview",
  "Plans & prices",
  "Users",
  "Orders",
  "Payment",
] as const;

export function AdminApp() {
  const [state, setState] = useState<"checking" | "out" | "in">("checking");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [email, setEmail] = useState("");

  const enter = useCallback(async () => {
    try {
      const me = await api<{ admin: { email: string } }>("/admin/me");
      setEmail(me.admin.email);
      setPlans((await api<{ plans: AdminPlan[] }>("/admin/plans")).plans);
      setState("in");
    } catch {
      setState("out");
    }
  }, []);
  useEffect(() => {
    void enter();
  }, [enter]);

  if (state === "checking")
    return (
      <div className="grid h-full place-items-center bg-canvas text-muted">
        Loading…
      </div>
    );
  if (state === "out") return <Login onDone={() => void enter()} />;

  const signOut = async () => {
    await api("/admin/logout", { body: {} }).catch(() => undefined);
    setState("out");
  };
  return (
    <div className="min-h-full bg-canvas font-ui text-ink">
      <header className="flex items-center gap-4 border-b border-line bg-surface px-5 py-3">
        <h1 className="font-semibold">
          <span className="text-key">erd</span>
          <span className="text-muted">.designer</span>{" "}
          <span className="text-[13px] font-normal text-muted">admin</span>
        </h1>
        <nav className="flex gap-1 overflow-x-auto" aria-label="Admin sections">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              aria-current={tab === t ? "page" : undefined}
              onClick={() => setTab(t)}
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-[13.5px] whitespace-nowrap ${tab === t ? "bg-key/15 text-key" : "text-muted hover:bg-hover hover:text-ink"}`}
            >
              {t}
            </button>
          ))}
        </nav>
        <span className="ml-auto hidden text-[13px] text-muted sm:inline">
          {email}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void signOut()}
          className="cursor-pointer"
        >
          Sign out
        </Button>
      </header>
      <main className="mx-auto max-w-6xl p-5">
        {tab === "Overview" && <OverviewTab plans={plans} />}
        {tab === "Plans & prices" && (
          <PlansTab
            plans={plans}
            onChange={(p) =>
              setPlans((all) => all.map((x) => (x.id === p.id ? p : x)))
            }
          />
        )}
        {tab === "Users" && <UsersTab plans={plans} />}
        {tab === "Orders" && <OrdersTab />}
        {tab === "Payment" && <PaymentTab />}
      </main>
    </div>
  );
}
