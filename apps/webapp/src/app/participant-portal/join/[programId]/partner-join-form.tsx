"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/trpc/react";
import { useSession } from "@/lib/auth-client";
import { usePartnerCode } from "@/hooks/use-partner-code";
import { PartnerCodeField } from "@/components/partner-code-field";
import { PartnerProgramTerms } from "@/components/partner-program-terms";
import { Button } from "@refref/ui/components/button";
import { Checkbox } from "@refref/ui/components/checkbox";
import { Skeleton } from "@refref/ui/components/skeleton";
import type { RouterOutputs } from "@/trpc/react";

export function PartnerJoinForm({ programId }: { programId: string }) {
  const session = useSession();
  const userId =
    !session.isPending && !session.error && session.data?.user.emailVerified
      ? session.data.user.id
      : "";
  if (session.isPending)
    return (
      <main className="mx-auto max-w-2xl p-6">
        <Skeleton className="h-56" />
      </main>
    );
  if (!userId)
    return (
      <main className="mx-auto max-w-2xl p-6">
        <p>Войдите в собственный подтверждённый аккаунт RefRef.</p>
        <Link
          className="underline"
          href={`/auth/sign-in?redirectTo=${encodeURIComponent(`/participant-portal/join/${programId}`)}`}
        >
          Войти в RefRef
        </Link>
      </main>
    );
  return (
    <ScopedJoinForm
      key={`${userId}:${programId}`}
      userId={userId}
      programId={programId}
    />
  );
}
function ScopedJoinForm({
  userId,
  programId,
}: {
  userId: string;
  programId: string;
}) {
  const query = api.participantPortal.participation.useQuery(
    { userId, programId },
    { retry: false },
  );
  const router = useRouter();
  useEffect(() => {
    if (query.isSuccess && query.data.state === "joined")
      router.replace(
        `/participant-portal?productId=${encodeURIComponent(query.data.productId)}`,
      );
  }, [query.isSuccess, query.data, router]);
  if (query.isError)
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Подключение к программе</h1>
        <p role="alert">{query.error.message}</p>
        <Button
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Повторить проверку
        </Button>
        <Link className="block underline" href="/participant-portal">
          Мой кабинет
        </Link>
      </main>
    );
  if (!query.data || query.data.state === "joined")
    return (
      <main className="mx-auto max-w-2xl p-6">
        <Skeleton className="h-56" />
      </main>
    );
  return (
    <JoinFields
      userId={userId}
      programId={programId}
      participation={query.data}
    />
  );
}
function JoinFields({
  userId,
  programId,
  participation,
}: {
  userId: string;
  programId: string;
  participation: Extract<
    RouterOutputs["participantPortal"]["participation"],
    { state: "join" }
  >;
}) {
  const initialCode =
    participation.codes[0]?.code ?? participation.suggestedCode ?? "";
  const [code, setCode] = useState(initialCode);
  const [acceptedVersion, setAcceptedVersion] = useState<string | null>(null);
  const busy = useRef(false);
  const utils = api.useUtils();
  const router = useRouter();
  const hasCode = participation.codes.length > 0;
  const availability = usePartnerCode({
    userId,
    programId,
    value: code,
    enabled: !hasCode,
  });
  const join = api.participantPortal.join.useMutation({
    onSuccess: (result) =>
      router.replace(
        `/participant-portal?productId=${encodeURIComponent(result.productId)}`,
      ),
    onSettled: async () => {
      await Promise.all([
        utils.participantPortal.participation.invalidate({ userId, programId }),
        utils.participantPortal.memberships.invalidate({ userId }),
      ]);
    },
  });
  const rules = participation.rules;
  const accepted = acceptedVersion === rules.id;
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">{participation.programName}</h1>
      <p>
        Подключайтесь из собственного аккаунта RefRef. Аккаунт и покупка тарифа
        AI-маркетолога для участия не нужны; доступ к организации организатора
        не предоставляется.
      </p>
      <PartnerProgramTerms
        terms={rules.rewardConfig}
        commission={rules.commission}
        startDate={rules.startDate}
        endDate={rules.endDate}
      />
      <p className="text-sm text-muted-foreground">
        Возмездное участие — для подходящих плательщиков НПД, ИП и организаций в
        рамках их деятельности. Полные требования к участникам, выплатам и
        собственным налоговым обязанностям приведены в правилах.
      </p>
      <form
        className="space-y-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            busy.current ||
            !accepted ||
            (!hasCode && !availability.canSubmit)
          )
            return;
          busy.current = true;
          try {
            await join.mutateAsync({
              userId,
              programId,
              termsId: rules.id,
              acceptRules: true,
              code: hasCode ? participation.codes[0]!.code : availability.code,
            });
          } catch {
            /* Native mutation state displays the error; programme query revalidates the exact rules. */
          } finally {
            busy.current = false;
          }
        }}
      >
        {hasCode ? (
          <p>
            Ваши существующие коды сохраняются. Новый первый код не создаётся.
          </p>
        ) : (
          <PartnerCodeField
            value={code}
            onChange={setCode}
            availability={availability}
            disabled={join.isPending}
          />
        )}
        <div className="flex items-start gap-3">
          <Checkbox
            id="accept-programme-rules"
            checked={accepted}
            onCheckedChange={(checked) =>
              setAcceptedVersion(checked === true ? rules.id : null)
            }
            disabled={join.isPending}
          />
          <label htmlFor="accept-programme-rules" className="text-sm leading-5">
            Я принимаю{" "}
            <Link
              className="underline"
              href={`/participant-portal/rules/${rules.id}`}
              target="_blank"
              rel="noopener noreferrer"
              prefetch={false}
            >
              Правила партнёрской программы
              <span className="sr-only"> (откроются в новой вкладке)</span>
            </Link>{" "}
            этой редакции. Отметка не является согласием на рекламные рассылки.
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Редакция: {rules.publishedAt.toLocaleString("ru-RU")}. При изменении
          правил требуется новое явное согласие.
        </p>
        <Button
          type="submit"
          disabled={
            join.isPending || !accepted || (!hasCode && !availability.canSubmit)
          }
        >
          {join.isPending
            ? "Подключаем…"
            : hasCode
              ? "Принять редакцию"
              : "Подключиться и получить код"}
        </Button>
        {join.isError && (
          <p role="alert" className="text-sm text-destructive">
            {join.error.message} При потере связи проверьте кабинет или
            повторите проверку программы: повторное подключение не создаёт
            второй код.
          </p>
        )}
      </form>
      <Link
        className="inline-block text-sm underline"
        href="/participant-portal"
      >
        Мой кабинет RefRef
      </Link>
    </main>
  );
}
