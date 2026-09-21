"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MailboxMeta } from "@/types/mailbox";

export function SubAccountMailboxSection() {
  const { subAccountId, isAdmin } = useSubAccount();
  return isAdmin ? (
    <MailboxForm key={subAccountId} subAccountId={subAccountId} />
  ) : null;
}

function MailboxForm({ subAccountId }: { subAccountId: string }) {
  const { subAccount } = useSubAccount();
  const [config, setConfig] = useState<MailboxMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    host: "",
    username: "",
    password: "",
    sentFolder: "",
    useSmtpCredentials: false,
  });
  const alive = useRef(false);
  const locked = useRef(false);
  const url = `/api/sub-accounts/${subAccountId}/mailbox`;
  const smtp = subAccount?.smtpConfig;

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok)
          throw new Error(data.error || "Unable to load mailbox settings.");
        if (!cancelled) {
          setConfig(data.config);
          if (data.config)
            setForm({
              host: data.config.host,
              username: data.config.username,
              password: "",
              sentFolder: data.config.sentFolder ?? "",
              useSmtpCredentials: false,
            });
        }
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load mailbox settings."
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

  async function action(
    kind: "connect" | "sync" | "disconnect",
    event?: FormEvent
  ) {
    event?.preventDefault();
    if (locked.current) return;
    if (
      kind === "connect" &&
      (!form.host.trim() ||
        !form.username.trim() ||
        (!form.useSmtpCredentials && !form.password))
    ) {
      setError(
        "Enter the mailbox host, username and password, or explicitly reuse this sub-account’s SMTP credentials."
      );
      return;
    }
    locked.current = true;
    setBusy(kind);
    setError("");
    setMessage("");
    try {
      const res = await fetch(kind === "sync" ? `${url}/sync` : url, {
        method: kind === "disconnect" ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        ...(kind === "connect"
          ? { body: JSON.stringify({ ...form, sentFolder: form.sentFolder.trim() || undefined, port: 993 }) }
          : {}),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(
          data.error || `Mailbox ${kind} failed (HTTP ${res.status}).`
        );
      if (!alive.current) return;
      if (kind === "disconnect") {
        setConfig(null);
        setMessage(
          "Mailbox disconnected. Imported messages remain in Conversations."
        );
      }
      if (kind === "connect") {
        setConfig(data.config);
        setForm((old) => ({ ...old, password: "" }));
        setMessage(
          "Mailbox verified and connected. Initial import covers the last 30 days."
        );
      }
      if (kind === "sync") {
        setMessage(
          `Imported ${data.imported}, skipped ${data.skipped}. ${data.hasMore ? "More mail remains; sync again or wait for the next scheduled run." : "This sync batch is complete."}`
        );
        const fresh = await fetch(url);
        const updated = await fresh.json();
        if (!fresh.ok)
          throw new Error(
            updated.error || "Sync finished, but status could not be refreshed."
          );
        if (alive.current) setConfig(updated.config);
      }
    } catch (err) {
      if (alive.current)
        setError(
          err instanceof Error ? err.message : "Mailbox request failed."
        );
    } finally {
      locked.current = false;
      if (alive.current) setBusy("");
    }
  }

  return (
    <section className="bg-card rounded-2xl border p-6">
      <h2 className="text-base font-semibold">Email conversations</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Connect this sub-account’s mailbox to import Inbox and Sent mail into
        Conversations. Sending uses its existing SMTP connection. Originals and
        attachments stay in your mailbox.
      </p>
      {loading ? (
        <p className="mt-4 text-sm">Loading mailbox settings…</p>
      ) : (
        <>
          <div className="my-4 space-y-1 text-sm">
            <p>
              {config?.enabled ? "Connected and verified" : "Not connected"}
            </p>
            {config && (
              <>
                <p>
                  Verified:{" "}
                  {config.verifiedAt
                    ? new Date(config.verifiedAt).toLocaleString()
                    : "Not verified"}
                </p>
                <p>
                  Last sync:{" "}
                  {config.lastSyncAt
                    ? new Date(config.lastSyncAt).toLocaleString()
                    : "Not synced yet"}
                </p>
                <p>
                  Sent folder:{" "}
                  {config.sentFolder ||
                    "Not detected — Inbox only until a Sent folder is available"}
                </p>
                {config.lastError && (
                  <p role="alert" className="text-destructive">
                    Last sync error: {config.lastError}
                  </p>
                )}
              </>
            )}
            <p className="text-muted-foreground text-xs">
              Read-only import, initially up to 30 days. Connected mailboxes are
              checked every fifteen minutes when the sync schedule is running.
            </p>
          </div>
          <form
            onSubmit={(event) => void action("connect", event)}
            className="space-y-3"
          >
            <fieldset disabled={!!busy} className="space-y-3">
              {smtp && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.useSmtpCredentials}
                    onChange={(e) =>
                      setForm((old) => ({
                        ...old,
                        useSmtpCredentials: e.target.checked,
                        ...(e.target.checked
                          ? {
                              host: smtp.host,
                              username: smtp.username,
                              password: "",
                            }
                          : {}),
                      }))
                    }
                  />
                  Reuse this sub-account’s saved SMTP username and password
                  (same host and username only)
                </label>
              )}
              <div>
                <Label htmlFor="mailbox-host">IMAP host (TLS port 993)</Label>
                <Input
                  id="mailbox-host"
                  required
                  value={form.host}
                  disabled={form.useSmtpCredentials}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="mailbox-username">Mailbox username</Label>
                <Input
                  id="mailbox-username"
                  required
                  value={form.username}
                  disabled={form.useSmtpCredentials}
                  onChange={(e) =>
                    setForm({ ...form, username: e.target.value })
                  }
                />
              </div>
              {!form.useSmtpCredentials && (
                <div>
                  <Label htmlFor="mailbox-password">
                    Mailbox password or app password
                  </Label>
                  <Input
                    id="mailbox-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={form.password}
                    onChange={(e) =>
                      setForm({ ...form, password: e.target.value })
                    }
                  />
                </div>
              )}
              <div>
                <Label htmlFor="mailbox-sent">
                  Sent folder (optional, auto-detected when blank)
                </Label>
                <Input
                  id="mailbox-sent"
                  value={form.sentFolder}
                  onChange={(e) =>
                    setForm({ ...form, sentFolder: e.target.value })
                  }
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit">
                  {busy === "connect" ? "Verifying…" : "Verify and connect"}
                </Button>
                {config && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!config.enabled}
                      onClick={() => void action("sync")}
                    >
                      {busy === "sync" ? "Syncing…" : "Sync now"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void action("disconnect")}
                    >
                      Disconnect mailbox
                    </Button>
                  </>
                )}
              </div>
            </fieldset>
          </form>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive mt-3 text-sm">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
