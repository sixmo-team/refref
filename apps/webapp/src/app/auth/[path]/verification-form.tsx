"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Button } from "@refref/ui/components/button";
import { Input } from "@refref/ui/components/input";
import { Label } from "@refref/ui/components/label";

/** The installed AuthView EMAIL_VERIFICATION is OTP-only; use the native email-link endpoint. */
export function VerificationForm({
  callbackURL,
  initialEmail = "",
}: {
  callbackURL: string;
  initialEmail?: string;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  return (
    <section
      className="w-full rounded-xl border bg-card p-8 shadow-lg"
      aria-labelledby="verification-title"
    >
      <h1 id="verification-title" className="text-2xl font-semibold">
        Verify your email address
      </h1>
      <p className="text-muted-foreground my-4 text-sm">
        Use the link in your RefRef verification email. Receiving an email does
        not join a programme or accept its rules.
      </p>
      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy.current) return;
          busy.current = true;
          setPending(true);
          setFailed(false);
          setMessage("");
          try {
            await authClient.sendVerificationEmail({
              email,
              callbackURL,
              fetchOptions: { throw: true },
            });
            setMessage(
              "If this account needs verification, a verification email was requested. Delivery is not confirmed here. Check your inbox and spam folder, or try again later.",
            );
          } catch {
            setFailed(true);
            setMessage(
              "The request could not be completed. Please try again later.",
            );
          } finally {
            busy.current = false;
            setPending(false);
          }
        }}
      >
        <Label htmlFor="verification-email">RefRef account email</Label>
        <Input
          id="verification-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
        />
        <Button type="submit" disabled={pending}>
          {pending ? "Requesting…" : "Request verification email"}
        </Button>
      </form>
      {message && (
        <p role={failed ? "alert" : "status"} className="my-4 text-sm">
          {message}
        </p>
      )}
      <Link
        className="mt-4 block text-sm underline"
        href={`/auth/sign-in?redirectTo=${encodeURIComponent(callbackURL)}`}
      >
        Back to sign in
      </Link>
    </section>
  );
}
