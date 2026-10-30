"use client";

import { useEffect, useState } from "react";
import { completePasswordReset, verifyPasswordReset } from "@/lib/firebase/auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type State =
  | { step: "checking" }
  | { step: "invalid" }
  | { step: "form"; email: string }
  | { step: "done"; email: string };

/**
 * Second half of the password reset: the page the emailed link opens.
 * Verifies the one-time code, takes a new password, then hands back to the
 * sign-in form with the email pre-filled.
 */
export function ResetPasswordForm({ code }: { code: string }) {
  const [state, setState] = useState<State>({ step: "checking" });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    verifyPasswordReset(code).then(
      (email) => {
        if (!cancelled) setState({ step: "form", email });
      },
      () => {
        if (!cancelled) setState({ step: "invalid" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.step !== "form") return;
    setError("");
    setLoading(true);
    try {
      await completePasswordReset(code, password);
      setState({ step: "done", email: state.email });
    } catch (err) {
      // The code can expire or be spent between the check above and submit.
      const errCode = (err as { code?: string }).code;
      if (
        errCode === "auth/expired-action-code" ||
        errCode === "auth/invalid-action-code"
      ) {
        setState({ step: "invalid" });
        return;
      }
      setError(
        err instanceof Error ? err.message : "Could not set the new password.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (state.step === "checking") {
    return <div className="h-[420px] rounded-xl border bg-card" />;
  }

  if (state.step === "invalid") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>This link has expired</CardTitle>
          <CardDescription>
            Reset links work once and expire after 1 hour. Request a new one
            from the sign-in page.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            variant="outline"
            className="w-full"
            render={<a href="/login" />}
          >
            Back to sign in
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (state.step === "done") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password updated</CardTitle>
          <CardDescription>
            Sign in with your new password to continue.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            className="w-full"
            render={
              <a href={`/login?email=${encodeURIComponent(state.email)}`} />
            }
          >
            Sign in
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set a new password</CardTitle>
        <CardDescription>
          For <span className="text-foreground">{state.email}</span>
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Saving…" : "Set new password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
