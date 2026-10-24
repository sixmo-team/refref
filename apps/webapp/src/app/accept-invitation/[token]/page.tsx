import { redirect } from "next/navigation";
import { logger } from "@/lib/logger";
import { headers as getHeaders } from "next/headers";
import { auth } from "@/lib/auth";
import { safeError } from "@refref/utils";

export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const headers = await getHeaders();
  const session = await auth.api.getSession({
    headers,
  });
  if (!session?.user) {
    // Redirect to signin but keep the token in the URL for after signin
    const callbackUrl = `/accept-invitation/${encodeURIComponent(token)}`;
    redirect(`/auth/sign-in?${new URLSearchParams({ callbackUrl })}`);
  }

  try {
    // Accept the invitation server-side
    await auth.api.acceptInvitation({
      body: {
        invitationId: token,
      },
      headers,
    });
  } catch (error) {
    logger.error("Error accepting invitation", safeError(error));
    return (
      <div className="container flex items-center justify-center min-h-[400px]">
        <p role="alert" className="text-destructive">
          Failed to accept invitation. The invitation may be invalid or expired.
        </p>
      </div>
    );
  }
  redirect("/");
}
