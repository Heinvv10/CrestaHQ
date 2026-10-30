"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SmtpMeta } from "@/types/email";

type Settings = {
  config: SmtpMeta | null;
  provider: "smtp" | "resend";
  resendReady: boolean;
};
const empty = {
  host: "",
  port: 587,
  secure: false,
  username: "",
  password: "",
  fromEmail: "",
  fromName: "",
};

export function SubAccountSmtpSection() {
  const { subAccountId, isAdmin } = useSubAccount();
  return isAdmin ? (
    <SmtpForm key={subAccountId} subAccountId={subAccountId} />
  ) : null;
}

function SmtpForm({ subAccountId }: { subAccountId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const alive = useRef(false);
  const locked = useRef(false);
  const url = `/api/sub-accounts/${subAccountId}/smtp`;

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok)
          throw new Error(data.error || "Unable to load SMTP settings.");
        if (!cancelled) {
          setSettings(data);
          setForm(
            data.config
              ? {
                  host: data.config.host,
                  port: data.config.port,
                  secure: data.config.secure,
                  username: data.config.username,
                  password: "",
                  fromEmail: data.config.fromEmail,
                  fromName: data.config.fromName,
                }
              : empty
          );
        }
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Unable to load SMTP settings."
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [url]);

  const old = settings?.config;
  const preservePassword =
    !!old &&
    old.host === form.host.trim() &&
    old.port === form.port &&
    old.secure === form.secure &&
    old.username === form.username.trim();

  async function action(kind: "save" | "test" | "remove", e?: FormEvent) {
    e?.preventDefault();
    if (locked.current || !settings) return;
    setError("");
    setMessage("");
    if (kind === "save") {
      if (
        !form.host.trim() ||
        !form.username.trim() ||
        !form.fromEmail.trim() ||
        (!preservePassword && !form.password)
      ) {
        setError("Enter the SMTP host, username, password and From email.");
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.fromEmail.trim())) {
        setError("Enter a valid From email.");
        return;
      }
    }
    locked.current = true;
    setBusy(kind);
    try {
      const res = await fetch(
        kind === "test" ? `${url}/test` : url,
        kind === "save"
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                host: form.host.trim(),
                port: form.port,
                secure: form.secure,
                username: form.username.trim(),
                password: form.password,
                fromEmail: form.fromEmail.trim(),
                fromName: form.fromName.trim(),
              }),
            }
          : { method: kind === "test" ? "POST" : "DELETE" }
      );
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error || "SMTP action failed. Please try again.");
      if (!alive.current) return;
      if (kind === "test") {
        setMessage(
          "Test email accepted by your provider for your signed-in admin email. Acceptance does not guarantee inbox delivery; check your inbox and spam folder."
        );
      } else {
        // Block stale actions if the mutation succeeds but refreshing fails.
        setSettings(null);
        setForm(empty);
        // Reload only public metadata; never reflect an existing password.
        const refresh = await fetch(url);
        const current = await refresh.json();
        if (!refresh.ok)
          throw new Error(
            "Settings changed, but could not be refreshed. Reload this page before continuing."
          );
        if (!alive.current) return;
        setSettings(current);
        setForm(
          current.config
            ? {
                host: current.config.host,
                port: current.config.port,
                secure: current.config.secure,
                username: current.config.username,
                password: "",
                fromEmail: current.config.fromEmail,
                fromName: current.config.fromName,
              }
            : empty
        );
        setMessage(
          kind === "save"
            ? "SMTP connection verified and saved. No test email was sent."
            : "SMTP disconnected. Resend is selected."
        );
      }
    } catch (err) {
      if (alive.current)
        setError(
          err instanceof Error
            ? err.message
            : "SMTP action failed. Please try again."
        );
    } finally {
      locked.current = false;
      if (alive.current) setBusy("");
    }
  }

  return (
    <section className="bg-card rounded-2xl border p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <Mail className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Email provider</h2>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Connect this business&apos;s own SMTP provider using its actual
            account credentials. Your provider must authorize the From address.
          </p>
        </div>
      </header>
      {error && (
        <p role="alert" className="text-destructive mb-4 text-sm">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mb-4 text-sm">
          {message}
        </p>
      )}
      {loading ? (
        <p className="text-muted-foreground text-sm">Loading email settings…</p>
      ) : (
        settings && (
          <>
            <p className="mb-4 text-sm">
              {settings.provider === "smtp"
                ? `Active provider: SMTP${settings.config ? ` (${settings.config.fromEmail})` : ""}. SMTP failures will not fall back to Resend.`
                : settings.resendReady
                  ? "Active provider: Resend. Uses your verified sending domain when available, otherwise the shared sender."
                  : "Resend is selected, but is not configured. Email sending is unavailable until SMTP or Resend is configured."}
            </p>
            <form onSubmit={(e) => void action("save", e)} noValidate>
              <fieldset disabled={!!busy} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ["host", "SMTP host", "text"],
                      ["username", "Username", "text"],
                      ["password", "Password", "password"],
                      ["fromEmail", "From email", "email"],
                      ["fromName", "From name (optional)", "text"],
                    ] as const
                  ).map(([key, label, type]) => (
                    <div key={key} className="space-y-1.5">
                      <Label htmlFor={`smtp-${key}`}>{label}</Label>
                      <Input
                        id={`smtp-${key}`}
                        type={type}
                        autoComplete={
                          key === "password" ? "new-password" : "off"
                        }
                        maxLength={key === "password" ? 1024 : 254}
                        value={form[key]}
                        required={
                          key !== "fromName" &&
                          (key !== "password" || !preservePassword)
                        }
                        onChange={(e) =>
                          setForm({ ...form, [key]: e.target.value })
                        }
                      />
                      {key === "password" && old && (
                        <p className="text-muted-foreground text-xs">
                          Leave blank to keep the saved password only when host,
                          port, security and username are unchanged.
                        </p>
                      )}
                    </div>
                  ))}
                  <div className="space-y-1.5">
                    <Label htmlFor="smtp-port">Port and security</Label>
                    <select
                      id="smtp-port"
                      className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                      value={form.port}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          port: Number(e.target.value),
                          secure: e.target.value === "465",
                        })
                      }
                    >
                      <option value={587}>587 — STARTTLS required</option>
                      <option value={465}>465 — TLS</option>
                      <option value={2525}>2525 — STARTTLS required</option>
                    </select>
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">
                  Verify &amp; save checks the connection and authentication
                  before changing the active provider. It does not prove message
                  delivery.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm">
                    {busy === "save" ? "Verifying…" : "Verify & save"}
                  </Button>
                  {settings.provider === "smtp" && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void action("test")}
                      >
                        {busy === "test" ? "Sending…" : "Send test email"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (
                            window.confirm(
                              settings.resendReady
                                ? "Disconnect SMTP and switch to Resend?"
                                : "Disconnect SMTP? Resend is not configured, so email sending will be unavailable."
                            )
                          )
                            void action("remove");
                        }}
                      >
                        {busy === "remove"
                          ? "Disconnecting…"
                          : "Disconnect SMTP"}
                      </Button>
                    </>
                  )}
                </div>
                {settings.provider === "smtp" && (
                  <p className="text-muted-foreground text-xs">
                    Send test email uses the saved settings and sends only to
                    your signed-in admin email. Provider acceptance does not
                    guarantee inbox delivery.
                  </p>
                )}
              </fieldset>
            </form>
          </>
        )
      )}
    </section>
  );
}
