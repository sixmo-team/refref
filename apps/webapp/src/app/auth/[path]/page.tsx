import { AuthView } from "@daveyplate/better-auth-ui";
import { authViewPaths } from "@daveyplate/better-auth-ui/server";
import Image from "next/image";
import Link from "next/link";
import { getAuthReturnPath } from "@refref/auth/return";
import { VerificationForm } from "./verification-form";

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

export default async function AuthPage({
  params,
  searchParams,
}: {
  params: Promise<{ path: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { path } = await params;
  const query = await searchParams;
  const redirectTo = getAuthReturnPath(query.redirectTo) ?? "/";
  if (query.redirectTo !== undefined && !getAuthReturnPath(query.redirectTo)) {
    return (
      <main className="p-8">
        <p role="alert">Invalid authentication return destination.</p>
        <Link href="/auth/sign-in">Sign in to RefRef</Link>
      </main>
    );
  }
  if (path === authViewPaths.EMAIL_VERIFICATION) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md">
          <VerificationForm
            callbackURL={redirectTo}
            initialEmail={typeof query.email === "string" ? query.email : ""}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center p-4">
      <div className="w-full max-w-md">
        <AuthView
          path={path}
          redirectTo={redirectTo}
          callbackURL={redirectTo}
          cardFooter={
            path === authViewPaths.SIGN_IN || path === authViewPaths.SIGN_UP ? (
              <Link
                className="text-sm underline"
                href={`/auth/email-verification?redirectTo=${encodeURIComponent(redirectTo)}`}
              >
                Need a new verification email?
              </Link>
            ) : undefined
          }
          cardHeader={
            <div className="mb-8 flex flex-col items-center gap-4">
              <Image
                src="/logo.svg"
                alt="RefRef"
                width={120}
                height={40}
                className="h-10 w-auto"
                priority
              />
              <div className="text-center">
                <h1 className="text-2xl font-semibold tracking-tight">
                  Welcome to RefRef
                </h1>
                <p className="text-muted-foreground text-sm mt-2">
                  Manage your referral programs with ease
                </p>
              </div>
            </div>
          }
          className="w-full border shadow-lg p-8"
          //! the width part for the separator or continue with was having issues
          classNames={{
            separator: "data-[orientation=horizontal]:!w-auto",
          }}
        />
      </div>
    </main>
  );
}
