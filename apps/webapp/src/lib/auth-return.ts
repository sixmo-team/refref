import { getAuthReturnPath } from "@refref/auth/return";

/** Better Auth UI omits redirectTo on a few view transitions and carries spent reset tokens. */
export function preserveAuthReturn(
  href: string,
  destination: string | undefined,
): string {
  const safe = getAuthReturnPath(href);
  if (!safe) return "/auth/sign-in";
  const url = new URL(safe, "https://internal.invalid");
  if (!url.pathname.startsWith("/auth/")) return safe;
  if (url.pathname !== "/auth/reset-password") url.searchParams.delete("token");
  const redirectTo =
    getAuthReturnPath(url.searchParams.get("redirectTo") ?? undefined) ??
    getAuthReturnPath(destination);
  if (redirectTo) url.searchParams.set("redirectTo", redirectTo);
  else url.searchParams.delete("redirectTo");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The installed UI's forgot-password form has no redirectTo prop; retain it in its native request. */
export function withPasswordResetReturn(
  body: Record<string, unknown>,
  destination: string | undefined,
  origin: string,
): Record<string, unknown> {
  const redirectTo = getAuthReturnPath(destination);
  if (!redirectTo || typeof body.redirectTo !== "string") return body;
  const reset = new URL(body.redirectTo, origin);
  if (
    reset.origin !== new URL(origin).origin ||
    reset.pathname !== "/auth/reset-password"
  )
    return body;
  reset.searchParams.set("redirectTo", redirectTo);
  return { ...body, redirectTo: reset.href };
}
