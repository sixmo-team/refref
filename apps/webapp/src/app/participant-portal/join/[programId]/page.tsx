import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { referralIdSchema } from "@refref/types";
import { auth } from "@/lib/auth";
import { PartnerJoinForm } from "./partner-join-form";

export default async function PartnerJoinPage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  if (!referralIdSchema.safeParse(programId).success) notFound();
  const entry = `/participant-portal/join/${encodeURIComponent(programId)}`;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    redirect(`/auth/sign-up?redirectTo=${encodeURIComponent(entry)}`);
  if (!session.user.emailVerified)
    redirect(
      `/auth/email-verification?redirectTo=${encodeURIComponent(entry)}`,
    );
  return <PartnerJoinForm programId={programId} />;
}
