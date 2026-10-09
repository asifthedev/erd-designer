import { Check, LoaderCircle, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/auth/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Admin > AI: everything about the assistant in one place: the gateway and its key, which models people can pick (and
 * which are cheap enough for the Free plan), the daily limits, a spend cap, an on/off switch and the usage so far.
 * Saved values win over the server environment; a field left empty falls back to it.
 */

type Tier = "fast" | "smart";
type ModelEntry = { id: string; tier: Tier };
type KeyState = {
  set: boolean;
  source: "dashboard" | "environment" | null;
  hint: string | null;
  unreadable: boolean;
};
type Day = {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  users: number;
};
type Snapshot = {
  enabled: boolean;
  gatewayBaseUrl: string | null;
  gatewayKey: KeyState;
  anthropicKey: KeyState;
  models: ModelEntry[] | null;
  offerAllModels: boolean;
  defaultModel: string | null;
  dailyLimitFree: number | null;
  dailyLimitPaid: number | null;
  maxDailySpendUsd: number | null;
  effective: {
    gatewayBaseUrl: string;
    dailyLimitFree: number;
    dailyLimitPaid: number;
    maxDailySpendUsd: number | null;
    defaultModel: string | null;
    modelsFromEnvironment: boolean;
  };
  defaults: {
    gatewayBaseUrl: string;
    models: ModelEntry[] | null;
    modelCount: number;
  };
  usage: Day[];
};
type Found = { id: string; name: string; contextLength: number | null };
type TryResult = {
  ok: boolean;
  message: string;
  toolCalled?: boolean;
  ms?: number;
  costUsd?: number;
};

const card = "rounded-2xl border border-line bg-surface p-5";
const select =
  "h-9 rounded-md border border-line bg-canvas px-2 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-key";
const PRESETS = [
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { name: "Vercel AI Gateway", url: "https://ai-gateway.vercel.sh/v1" },
];
const message = (e: unknown) =>
  e instanceof ApiError ? e.message : "Something went wrong. Please try again.";

const toInt = (s: string): number | null | "bad" => {
  if (!s.trim()) return null;
  return /^\d{1,6}$/.test(s.trim()) ? Number(s) : "bad";
};
const toMoney = (s: string): number | null | "bad" => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? n : "bad";
};
const usd = (n: number) =>
  n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(n < 10 ? 3 : 2)}`;

function KeyField({
  label,
  state,
  value,
  onChange,
  remove,
  onRemove,
  hint,
}: {
  label: string;
  state: KeyState;
  value: string;
  onChange: (v: string) => void;
  remove: boolean;
  onRemove: (v: boolean) => void;
  hint?: string;
}) {
  const status = state.unreadable
    ? "The saved key can no longer be read (the server secret changed). Paste it again."
    : remove
      ? "The saved key will be removed when you save."
      : state.set
        ? state.source === "dashboard"
          ? `Saved ${state.hint}. Paste a new one to replace it.`
          : `Using the key from the server environment (${state.hint}). Paste one here to override it.`
        : "No key yet.";
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={label}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={label}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={state.set ? "••••••••••••" : "Paste the API key"}
          onChange={(e) => {
            onChange(e.target.value);
            onRemove(false);
          }}
        />
        {state.source === "dashboard" && !remove && (
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={() => {
              onRemove(true);
              onChange("");
            }}
          >
            Remove
          </Button>
        )}
        {remove && (
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={() => onRemove(false)}
          >
            Keep
          </Button>
        )}
      </div>
      <p className={`text-[12.5px] ${state.unreadable ? "text-danger" : "text-muted"}`}>
        {status} {hint}
      </p>
    </div>
  );
}

export function AiTab() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // The form (what is typed), separate from what is saved.
  const [enabled, setEnabled] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [newKey, setNewKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [newAnthropic, setNewAnthropic] = useState("");
  const [removeAnthropic, setRemoveAnthropic] = useState(false);
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [offerAll, setOfferAll] = useState(false);
  const [defaultModel, setDefaultModel] = useState("");
  const [limitFree, setLimitFree] = useState("");
  const [limitPaid, setLimitPaid] = useState("");
  const [spend, setSpend] = useState("");

  const [found, setFound] = useState<Found[] | null>(null);
  const [connection, setConnection] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [query, setQuery] = useState("");
  const [tries, setTries] = useState<Record<string, TryResult | "running">>({});

  const fill = useCallback((s: Snapshot) => {
    setSnap(s);
    setEnabled(s.enabled);
    setBaseUrl(s.gatewayBaseUrl ?? "");
    setNewKey("");
    setRemoveKey(false);
    setNewAnthropic("");
    setRemoveAnthropic(false);
    setModels(s.models);
    setOfferAll(s.offerAllModels);
    setDefaultModel(s.defaultModel ?? "");
    setLimitFree(s.dailyLimitFree?.toString() ?? "");
    setLimitPaid(s.dailyLimitPaid?.toString() ?? "");
    setSpend(s.maxDailySpendUsd?.toString() ?? "");
  }, []);
  useEffect(() => {
    api<Snapshot>("/admin/ai").then(fill, (e) => setError(message(e)));
  }, [fill]);

  const limits = {
    free: toInt(limitFree),
    paid: toInt(limitPaid),
    spend: toMoney(spend),
  };
  const invalid =
    limits.free === "bad" || limits.paid === "bad" || limits.spend === "bad";

  /** Only what differs from what is saved: a save never overwrites what it did not touch. */
  const patch = useMemo(() => {
    if (!snap) return {};
    const p: Record<string, unknown> = {};
    if (enabled !== snap.enabled) p.enabled = enabled;
    if ((baseUrl.trim() || null) !== snap.gatewayBaseUrl) p.gatewayBaseUrl = baseUrl.trim() || null;
    if (newKey.trim()) p.gatewayKey = newKey.trim();
    else if (removeKey) p.gatewayKey = null;
    if (newAnthropic.trim()) p.anthropicKey = newAnthropic.trim();
    else if (removeAnthropic) p.anthropicKey = null;
    if (JSON.stringify(models) !== JSON.stringify(snap.models)) p.models = models;
    if (offerAll !== snap.offerAllModels) p.offerAllModels = offerAll;
    if ((defaultModel.trim() || null) !== snap.defaultModel) p.defaultModel = defaultModel.trim() || null;
    if (!invalid) {
      if (limits.free !== snap.dailyLimitFree) p.dailyLimitFree = limits.free;
      if (limits.paid !== snap.dailyLimitPaid) p.dailyLimitPaid = limits.paid;
      if (limits.spend !== snap.maxDailySpendUsd) p.maxDailySpendUsd = limits.spend;
    }
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, enabled, baseUrl, newKey, removeKey, newAnthropic, removeAnthropic, models, offerAll, defaultModel, limitFree, limitPaid, spend]);
  const dirty = Object.keys(patch).length > 0;
  const connectionDirty = "gatewayBaseUrl" in patch || "gatewayKey" in patch;

  const save = async () => {
    setSaving(true);
    setNote(null);
    try {
      fill(await api<Snapshot>("/admin/ai", { method: "PUT", body: patch }));
      setNote({ ok: true, text: "Saved. It applies to new messages within a few seconds." });
      setTries({});
    } catch (e) {
      setNote({ ok: false, text: message(e) });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setConnection(null);
    try {
      const r = await api<{ ok: boolean; message: string; models?: Found[] }>("/admin/ai/test", {
        body: {
          ...(baseUrl.trim() ? { gatewayBaseUrl: baseUrl.trim() } : {}),
          ...(newKey.trim() ? { gatewayKey: newKey.trim() } : {}),
        },
      });
      setConnection({ ok: r.ok, text: r.message });
      if (r.ok && r.models) setFound(r.models);
    } catch (e) {
      setConnection({ ok: false, text: message(e) });
    } finally {
      setTesting(false);
    }
  };

  const tryModel = async (id: string) => {
    setTries((t) => ({ ...t, [id]: "running" }));
    try {
      const r = await api<TryResult>("/admin/ai/test-model", { body: { model: id } });
      setTries((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTries((t) => ({ ...t, [id]: { ok: false, message: message(e) } }));
    }
  };

  const addModel = (id: string, tier: Tier = "smart") => {
    const clean = id.trim();
    if (!clean) return;
    setModels((m) => {
      const list = m ?? [];
      return list.some((x) => x.id === clean) ? list : [...list, { id: clean, tier }];
    });
    setQuery("");
  };

  if (error) return <p className="text-danger">{error}</p>;
  if (!snap)
    return (
      <p className="text-muted">
        <LoaderCircle className="mr-2 inline animate-spin" size={16} /> Loading…
      </p>
    );

  const today = snap.usage[0]?.day === new Date().toISOString().slice(0, 10) ? snap.usage[0] : null;
  const suggestions =
    found && query.trim()
      ? found
          .filter(
            (m) =>
              (m.id + m.name).toLowerCase().includes(query.trim().toLowerCase()) &&
              !(models ?? []).some((x) => x.id === m.id),
          )
          .slice(0, 8)
      : [];
  const listed = models ?? snap.defaults.models ?? [];
  const ready = snap.gatewayKey.set || newKey.trim().length > 0 || snap.anthropicKey.set;

  return (
    <div className="grid max-w-3xl gap-5 pb-24">
      <section className={`${card} grid gap-4`}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">AI assistant</h2>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[12px] ${enabled && ready ? "bg-ok/15 text-ok" : "bg-hover text-muted"}`}
          >
            {!ready ? "Needs a key" : enabled ? "On" : "Off"}
          </span>
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-[13.5px]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="size-4 accent-[var(--color-key)]"
            />
            Assistant is available to users
          </label>
        </div>
        <p className="text-[13.5px] text-muted">
          Users describe a database (or paste a schema) and the assistant draws and edits it on their canvas. It needs a
          gateway key: one key gives access to models from many companies.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Requests today", today ? today.requests.toLocaleString() : "0"],
            ["People today", today ? String(today.users) : "0"],
            ["Tokens today", today ? (today.inputTokens + today.outputTokens).toLocaleString() : "0"],
            ["Spend today", today ? usd(today.costUsd) : "$0"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-line bg-canvas px-3 py-2">
              <div className="text-[12px] text-muted">{label}</div>
              <div className="text-[18px] font-semibold">{value}</div>
            </div>
          ))}
        </div>
        {snap.usage.length > 1 && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted">Last 7 days</summary>
            <table className="mt-2 w-full text-left">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 font-normal">Day (UTC)</th>
                  <th className="font-normal">Requests</th>
                  <th className="font-normal">People</th>
                  <th className="font-normal">Spend</th>
                </tr>
              </thead>
              <tbody>
                {snap.usage.map((d) => (
                  <tr key={d.day} className="border-t border-line">
                    <td className="py-1">{d.day}</td>
                    <td>{d.requests.toLocaleString()}</td>
                    <td>{d.users}</td>
                    <td>{usd(d.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <section className={`${card} grid gap-4`}>
        <h2 className="font-semibold">Gateway</h2>
        <div className="grid gap-1.5">
          <Label htmlFor="gateway-url">Gateway address</Label>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.url}
                type="button"
                onClick={() => setBaseUrl(p.url)}
                className={`cursor-pointer rounded-md border px-2.5 py-1 text-[13px] ${(baseUrl || snap.defaults.gatewayBaseUrl) === p.url ? "border-key text-key" : "border-line text-muted hover:border-key"}`}
              >
                {p.name}
              </button>
            ))}
          </div>
          <Input
            id="gateway-url"
            value={baseUrl}
            placeholder={snap.defaults.gatewayBaseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            spellCheck={false}
          />
          <p className="text-[12.5px] text-muted">
            Any OpenAI-compatible address (https). Empty uses {snap.effective.gatewayBaseUrl}.
          </p>
        </div>
        <KeyField
          label="Gateway API key"
          state={snap.gatewayKey}
          value={newKey}
          onChange={setNewKey}
          remove={removeKey}
          onRemove={setRemoveKey}
          hint="Stored encrypted; it is never shown again."
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={testing || (!snap.gatewayKey.set && !newKey.trim())}
            onClick={() => void testConnection()}
            className="cursor-pointer"
          >
            {testing && <LoaderCircle className="mr-2 animate-spin" size={14} />}
            Test connection
          </Button>
          {connection && (
            <p role="status" className={`text-[13px] ${connection.ok ? "text-ok" : "text-danger"}`}>
              {connection.text}
            </p>
          )}
        </div>
      </section>

      <section className={`${card} grid gap-4`}>
        <h2 className="font-semibold">Models</h2>
        <p className="text-[13.5px] text-muted">
          What people can pick. <strong className="text-ink">Fast</strong> models are the cheap ones: the only kind the
          Free plan may use. Only models that can call tools work, so the assistant can edit the canvas.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            checked={offerAll}
            onChange={(e) => setOfferAll(e.target.checked)}
            className="size-4 accent-[var(--color-key)]"
          />
          Offer every model the gateway has that can call tools (up to 80)
        </label>
        {!offerAll && (
          <>
            {models === null && (
              <div className="rounded-xl border border-line bg-canvas p-3 text-[13px] text-muted">
                {snap.effective.modelsFromEnvironment
                  ? "Using the list set on the server."
                  : `Using the built-in list of ${snap.defaults.modelCount} models. Ones the gateway does not have are hidden automatically.`}{" "}
                <button
                  type="button"
                  className="cursor-pointer text-key underline"
                  onClick={() => setModels(snap.defaults.models ?? [])}
                >
                  Customize the list
                </button>
              </div>
            )}
            {models !== null && (
              <div className="grid gap-2">
                {listed.length === 0 && <p className="text-[13px] text-muted">No models yet. Add some below.</p>}
                {listed.map((m) => {
                  const t = tries[m.id];
                  return (
                    <div key={m.id} className="rounded-xl border border-line bg-canvas px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="mr-auto break-all text-[13px]">{m.id}</code>
                        <select
                          aria-label={`Tier of ${m.id}`}
                          className={select}
                          value={m.tier}
                          onChange={(e) =>
                            setModels((all) => (all ?? []).map((x) => (x.id === m.id ? { ...x, tier: e.target.value as Tier } : x)))
                          }
                        >
                          <option value="smart">Smart (paid plans)</option>
                          <option value="fast">Fast (Free plan too)</option>
                        </select>
                        <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-muted">
                          <input
                            type="radio"
                            name="default-model"
                            checked={defaultModel === m.id}
                            onChange={() => setDefaultModel(m.id)}
                          />
                          Default
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="cursor-pointer"
                          disabled={connectionDirty || t === "running" || !ready}
                          title={connectionDirty ? "Save the gateway changes first" : "Send one tiny request that asks the model to call a tool"}
                          onClick={() => void tryModel(m.id)}
                        >
                          {t === "running" ? <LoaderCircle className="animate-spin" size={13} /> : "Try it"}
                        </Button>
                        <button
                          type="button"
                          aria-label={`Remove ${m.id}`}
                          className="cursor-pointer text-muted hover:text-danger"
                          onClick={() => {
                            setModels((all) => (all ?? []).filter((x) => x.id !== m.id));
                            if (defaultModel === m.id) setDefaultModel("");
                          }}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      {t && t !== "running" && (
                        <p className={`mt-1.5 flex items-center gap-1.5 text-[12.5px] ${t.ok && t.toolCalled ? "text-ok" : "text-danger"}`}>
                          {t.ok && t.toolCalled ? <Check size={13} /> : <X size={13} />}
                          {t.message}
                          {t.ok && t.ms ? ` · ${(t.ms / 1000).toFixed(1)}s` : ""}
                          {t.ok && t.costUsd ? ` · ${usd(t.costUsd)}` : ""}
                        </p>
                      )}
                    </div>
                  );
                })}
                <div className="relative">
                  <div className="flex gap-2">
                    <Input
                      value={query}
                      placeholder={found ? "Search the gateway's models, or type company/model" : "Type company/model, e.g. openai/gpt-5-mini (use Test connection to search)"}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addModel(query);
                        }
                      }}
                      spellCheck={false}
                    />
                    <Button type="button" variant="outline" className="cursor-pointer" onClick={() => addModel(query)} disabled={!query.trim()}>
                      <Plus size={15} /> Add
                    </Button>
                  </div>
                  {suggestions.length > 0 && (
                    <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
                      {suggestions.map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => addModel(m.id)}
                            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-hover"
                          >
                            <code className="break-all">{m.id}</code>
                            <span className="ml-auto truncate text-muted">{m.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <button
                  type="button"
                  className="w-fit cursor-pointer text-[12.5px] text-muted underline"
                  onClick={() => {
                    setModels(null);
                    setDefaultModel("");
                  }}
                >
                  Go back to the built-in list
                </button>
              </div>
            )}
          </>
        )}
        {offerAll && (
          <p className="text-[12.5px] text-muted">
            Every one is offered as a paid-plan model. Switch this off to choose which ones and mark the cheap ones.
          </p>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="default-model">Default model</Label>
          <Input
            id="default-model"
            value={defaultModel}
            placeholder={snap.effective.defaultModel ?? "The first model in the list"}
            onChange={(e) => setDefaultModel(e.target.value)}
            spellCheck={false}
          />
        </div>
      </section>

      <section className={`${card} grid gap-4`}>
        <h2 className="font-semibold">Limits</h2>
        <p className="text-[13.5px] text-muted">
          One request is one model call; changing the canvas takes a few. Counts reset at midnight UTC. Leave a field
          empty to use the default shown in it.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              ["Free plan, per person per day", limitFree, setLimitFree, snap.effective.dailyLimitFree, limits.free],
              ["Paid plans, per person per day", limitPaid, setLimitPaid, snap.effective.dailyLimitPaid, limits.paid],
              ["Spend cap for everybody per day (USD)", spend, setSpend, snap.effective.maxDailySpendUsd ?? "none", limits.spend],
            ] as const
          ).map(([label, value, set, def, parsed]) => (
            <div key={label} className="grid content-start gap-1.5">
              <Label>{label}</Label>
              <Input
                inputMode="decimal"
                value={value}
                placeholder={String(def)}
                onChange={(e) => set(e.target.value)}
                aria-invalid={parsed === "bad"}
              />
              {parsed === "bad" && <p className="text-[12px] text-danger">Enter a whole number above 0, or leave empty.</p>}
            </div>
          ))}
        </div>
        <p className="text-[12.5px] text-muted">
          The spend cap uses the cost the gateway reports (OpenRouter does) and stops the assistant for everybody for the
          rest of the day. 0 requests stops that group.
        </p>
      </section>

      <details className={card}>
        <summary className="cursor-pointer font-semibold">Direct Anthropic key (optional)</summary>
        <div className="mt-4">
          <KeyField
            label="Anthropic API key"
            state={snap.anthropicKey}
            value={newAnthropic}
            onChange={setNewAnthropic}
            remove={removeAnthropic}
            onRemove={setRemoveAnthropic}
            hint="Adds Claude models that skip the gateway (with prompt caching)."
          />
        </div>
      </details>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-5 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Button onClick={() => void save()} disabled={!dirty || saving || invalid} className="cursor-pointer">
            {saving && <LoaderCircle className="mr-2 animate-spin" size={14} />}
            Save changes
          </Button>
          <Button variant="outline" disabled={!dirty || saving} onClick={() => { fill(snap); setNote(null); }} className="cursor-pointer">
            Discard
          </Button>
          {note ? (
            <p role="status" className={`text-[13px] ${note.ok ? "text-ok" : "text-danger"}`}>
              {note.text}
            </p>
          ) : dirty ? (
            <p className="text-[13px] text-muted">Unsaved changes</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
