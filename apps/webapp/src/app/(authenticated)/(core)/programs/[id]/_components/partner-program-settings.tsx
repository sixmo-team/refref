"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { api, type RouterInputs, type RouterOutputs } from "@/trpc/react";
import { useActiveMember } from "@/lib/auth-client";
import { useDeniedRead } from "@/hooks/use-denied-read";
import { PartnerProgramTerms } from "@/components/partner-program-terms";
import { Button } from "@refref/ui/components/button";
import { Checkbox } from "@refref/ui/components/checkbox";
import { Textarea } from "@refref/ui/components/textarea";
import { Skeleton } from "@refref/ui/components/skeleton";

type Props = {
  program: Pick<
    RouterOutputs["program"]["getById"],
    "id" | "productId" | "status"
  >;
  scope: RouterInputs["program"]["getById"]["scope"];
};
export function PartnerProgramSettings(props: Props) {
  return (
    <ScopedSettings
      key={`${props.scope.userId}:${props.scope.organizationId}:${props.program.id}`}
      {...props}
    />
  );
}
function ScopedSettings({ program, scope }: Props) {
  const member = useActiveMember();
  const allowed =
    !member.isPending &&
    !member.isRefetching &&
    !member.error &&
    member.data?.userId === scope.userId &&
    member.data.organizationId === scope.organizationId &&
    (member.data.role === "owner" || member.data.role === "admin");
  const [draftBody, setDraftBody] = useState<string | null>(null);
  const input = { id: program.id, scope };
  const query = api.program.partnerRules.useQuery(input, { enabled: allowed });
  const utils = api.useUtils();
  const blocked = useDeniedRead({
    scopeKey: `${scope.userId}:${scope.organizationId}:${program.id}`,
    denied:
      !allowed ||
      query.error?.data?.code === "UNAUTHORIZED" ||
      query.error?.data?.code === "FORBIDDEN",
    queries: [query],
    reset: () => {
      void utils.program.partnerRules.reset(input);
    },
  });
  if (!allowed)
    return (
      <section className="space-y-3 p-6">
        <h2 className="text-xl font-semibold">Подключение партнёров</h2>
        <p>
          Управлять подключением и публиковать правила может администратор
          организации.
        </p>
        <Button
          disabled={member.isPending}
          onClick={() => void member.refetch()}
        >
          Проверить права
        </Button>
      </section>
    );
  if (blocked || query.isError)
    return (
      <section className="space-y-3 p-6">
        <p role="alert">Не удалось проверить доступ к настройкам партнёров.</p>
        <Button
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Повторить
        </Button>
      </section>
    );
  if (!query.data)
    return (
      <div className="p-6">
        <Skeleton className="h-56" />
      </div>
    );
  return (
    <RulesEditor
      program={program}
      scope={scope}
      settings={query.data}
      body={draftBody ?? query.data.rules?.body ?? ""}
      onBodyChange={setDraftBody}
    />
  );
}
function RulesEditor({
  program,
  scope,
  settings,
  body,
  onBodyChange,
}: Props & {
  settings: RouterOutputs["program"]["partnerRules"];
  body: string;
  onBodyChange: (body: string) => void;
}) {
  const [reviewedVersion, setReviewedVersion] = useState<string | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const utils = api.useUtils();
  const refresh = async () => {
    await Promise.all([
      utils.program.getById.invalidate({ id: program.id, scope }),
      utils.program.partnerRules.invalidate({ id: program.id, scope }),
      utils.program.getAll.invalidate(),
    ]);
  };
  const publish = api.program.publishPartnerRules.useMutation({
    onSettled: refresh,
  });
  const toggle = api.program.setPartnerSelfService.useMutation({
    onSettled: refresh,
  });
  const reviewKey = `${settings.termsFingerprint ?? ""}:${settings.rules?.id ?? ""}`;
  const reviewed = reviewedVersion === reviewKey;
  const pending = publish.isPending || toggle.isPending;
  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <h2 className="text-2xl font-semibold">
        Самостоятельное подключение партнёров
      </h2>
      <p>
        Вход выполняется через отдельный аккаунт RefRef с подтверждённой почтой.
        Участнику не нужен аккаунт AI-маркетолога, продукт или членство в вашей
        организации.
      </p>
      <p className="text-sm text-muted-foreground">
        Включение разрешает возмездное подключение после явного принятия
        опубликованных правил. Для выбранной модели допустимы подходящие
        плательщики НПД, ИП и организации; требования должны быть раскрыты в
        полном тексте до начала участия. Проверка формата реквизитов не является
        банковской или налоговой проверкой.
      </p>
      {settings.economics ? (
        <PartnerProgramTerms
          terms={settings.economics.rewardConfig}
          commission={settings.economics.commission}
          startDate={settings.economics.startDate}
          endDate={settings.economics.endDate}
        />
      ) : (
        <p role="status">
          Сначала настройте и одобрите финансовые условия в разделе
          вознаграждений. Без действующего экономического снимка публикация и
          новое подключение недоступны; выключить подключение можно всегда.
        </p>
      )}
      <p>
        Состояние:{" "}
        <strong>
          {settings.enabled ? "подключение разрешено" : "подключение выключено"}
        </strong>
        . Программа должна быть активна, финансовые условия одобрены, а правила
        соответствовать этим условиям.
      </p>
      <Button
        disabled={
          pending ||
          (!settings.enabled &&
            (!settings.rules ||
              !settings.economics ||
              program.status !== "active"))
        }
        onClick={async () => {
          if (busy.current) return;
          busy.current = true;
          setError("");
          try {
            await toggle.mutateAsync({
              productId: program.productId,
              programId: program.id,
              enabled: !settings.enabled,
            });
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Изменение не подтверждено; обновите настройки.",
            );
          } finally {
            busy.current = false;
          }
        }}
      >
        {settings.enabled ? "Выключить подключение" : "Разрешить подключение"}
      </Button>
      <p className="text-sm">
        Служебный адрес входа:{" "}
        <Link
          className="underline"
          href={`/participant-portal/join/${program.id}`}
          target="_blank"
          rel="noopener noreferrer"
          prefetch={false}
        >
          открыть RefRef для этой программы
        </Link>
        . Это не покупательская промоссылка и не доступ к админке.
      </p>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy.current || !reviewed || !settings.termsFingerprint) return;
          busy.current = true;
          setError("");
          try {
            await publish.mutateAsync({
              productId: program.productId,
              programId: program.id,
              body,
              termsFingerprint: settings.termsFingerprint,
              confirmReviewedRules: true,
            });
            setReviewedVersion(null);
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Публикация не подтверждена; проверьте текущую редакцию.",
            );
          } finally {
            busy.current = false;
          }
        }}
      >
        <label className="block space-y-2">
          <span className="font-medium">Полный текст правил</span>
          <Textarea
            value={body}
            onChange={(event) => {
              onBodyChange(event.target.value);
              setReviewedVersion(null);
            }}
            rows={18}
            minLength={200}
            maxLength={30000}
            required
            disabled={pending}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Укажите реального организатора и его реквизиты, допустимых участников,
          условия начисления, сроки и порядок ручных выплат, контакты и
          обязательные подтверждения. Проект из документации не публикуется
          автоматически. Принятые редакции и платёжные снимки не переписываются.
        </p>
        <div className="flex items-start gap-3">
          <Checkbox
            id="review-partner-rules"
            checked={reviewed}
            onCheckedChange={(checked) =>
              setReviewedVersion(checked === true ? reviewKey : null)
            }
            disabled={pending || !settings.termsFingerprint}
          />
          <label htmlFor="review-partner-rules" className="text-sm">
            Я проверил текст, данные организатора и соответствие показанным
            экономическим условиям; разрешаю публикацию этой редакции.
          </label>
        </div>
        <Button
          type="submit"
          disabled={pending || !reviewed || !settings.termsFingerprint}
        >
          {publish.isPending ? "Публикуем…" : "Опубликовать редакцию правил"}
        </Button>
      </form>
      {settings.rules && (
        <p className="text-sm">
          Текущая редакция от{" "}
          {settings.rules.publishedAt.toLocaleString("ru-RU")}:{" "}
          <Link
            className="underline"
            href={`/participant-portal/rules/${settings.rules.id}`}
            target="_blank"
            rel="noopener noreferrer"
            prefetch={false}
          >
            полный неизменяемый текст
          </Link>
          .
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
