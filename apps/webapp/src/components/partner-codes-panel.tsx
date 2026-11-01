"use client";
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, type RouterOutputs } from "@/trpc/react";
import { usePartnerCode } from "@/hooks/use-partner-code";
import { useDeniedRead } from "@/hooks/use-denied-read";
import { PartnerCodeField } from "@/components/partner-code-field";
import { Button } from "@refref/ui/components/button";
import { Skeleton } from "@refref/ui/components/skeleton";
import { getQueryKey } from "@trpc/react-query";

type Summary = RouterOutputs["participantPortal"]["summary"];
export function PartnerCodesPanel({
  userId,
  productId,
  codes,
  acceptedRules,
}: {
  userId: string;
  productId: string;
  codes: Summary["codes"];
  acceptedRules: Summary["acceptedRules"];
}) {
  const [period, setPeriod] = useState(() => ({ days: 30, asOf: new Date() }));
  const range = useMemo(
    () => ({
      from: new Date(period.asOf.getTime() - period.days * 86_400_000),
      to: period.asOf,
    }),
    [period],
  );
  const input = { userId, productId, ...range };
  const stats = api.participantPortal.codeStats.useQuery(input, {
    placeholderData: undefined,
  });
  const [programChoice, setProgramChoice] = useState("");
  const programs = [
    ...new Map(
      codes
        .filter(
          (code) => code.currentTermsId && code.programStatus === "active",
        )
        .map((code) => [
          code.programId,
          { id: code.programId, name: code.programName },
        ]),
    ).values(),
  ];
  const programId = programs.some((program) => program.id === programChoice)
    ? programChoice
    : programs.length === 1
      ? programs[0]!.id
      : "";
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");
  const availability = usePartnerCode({
    userId,
    programId,
    value: code,
    enabled: !!programId,
  });
  const busy = useRef(false);
  const utils = api.useUtils();
  const refresh = async () => {
    await Promise.all([
      utils.participantPortal.summary.invalidate({ userId, productId }),
      utils.participantPortal.codeStats.invalidate({ userId, productId }),
      utils.participantPortal.participation.invalidate({ userId }),
    ]);
  };
  const create = api.participantPortal.createCode.useMutation({
    onSettled: refresh,
  });
  const toggle = api.participantPortal.setCodeActive.useMutation({
    onSettled: refresh,
  });
  const denied = [stats.error, create.error, toggle.error].some(
    (error) =>
      error?.data?.code === "UNAUTHORIZED" || error?.data?.code === "FORBIDDEN",
  );
  const blocked = useDeniedRead({
    scopeKey: `${userId}:${productId}`,
    denied,
    queries: [stats],
    reset: (client) => {
      for (const query of [
        api.participantPortal.summary,
        api.participantPortal.history,
        api.participantPortal.codeStats,
      ])
        void client.resetQueries({
          queryKey: getQueryKey(query, { userId, productId }, "query"),
        });
    },
    dispose: (client) => {
      client.removeQueries({
        queryKey: getQueryKey(
          api.participantPortal.codeStats,
          { userId, productId },
          "query",
        ),
      });
    },
  });
  if (blocked)
    return (
      <section className="space-y-3">
        <p role="alert">
          Доступ к собственным кодам и результатам не подтверждён. Сохранённые
          данные скрыты.
        </p>
        <Button
          disabled={stats.isFetching}
          onClick={async () => {
            const checked = await stats.refetch();
            if (checked.isSuccess) {
              create.reset();
              toggle.reset();
            }
          }}
        >
          Проверить доступ
        </Button>
      </section>
    );
  const uncertainRetry =
    create.isError &&
    create.variables?.code === availability.code &&
    create.variables.programId === programId &&
    create.error.data?.code !== "CONFLICT" &&
    create.error.data?.code !== "BAD_REQUEST";
  return (
    <section className="space-y-5" aria-label="Мои промокоды">
      <h2 className="text-xl font-semibold">Мои промокоды</h2>
      <p className="text-sm text-muted-foreground">
        Сообщите код покупателю для ручного ввода на тарифах. При смене текста
        создайте новый код; отключение не удаляет принятые покупки и начисления.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          Период покупок
          <select
            className="block rounded border p-2"
            value={period.days}
            onChange={(event) => {
              const days = Number(event.target.value);
              if (days === 30 || days === 90 || days === 365)
                setPeriod({ days, asOf: new Date() });
            }}
          >
            <option value={30}>Последние 30 дней</option>
            <option value={90}>Последние 90 дней</option>
            <option value={365}>Последние 365 дней</option>
          </select>
        </label>
        <Button
          variant="outline"
          disabled={stats.isFetching}
          onClick={() =>
            setPeriod((current) => ({ ...current, asOf: new Date() }))
          }
        >
          Обновить результаты
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        До {range.to.toLocaleString("ru-RU")}. Покупки учитываются по времени
        подтверждённой оплаты; клики и установки не отслеживаются.
      </p>
      {stats.isError && (
        <p role="alert">
          Не удалось обновить статистику выбранного периода. Не считаем ошибку
          нулевыми продажами.
        </p>
      )}
      {stats.isPending && <Skeleton className="h-24" />}
      <div className="space-y-4">
        {codes.map((owned) => {
          const report = stats.data?.find((row) => row.codeId === owned.codeId);
          const accepted = acceptedRules.some(
            (rule) =>
              rule.programId === owned.programId &&
              rule.termsId === owned.currentTermsId,
          );
          return (
            <article
              key={owned.codeId}
              className="space-y-3 rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-center gap-3">
                <strong className="break-all font-mono text-lg">
                  {owned.code}
                </strong>
                <span className="text-sm">
                  {owned.programName} ·{" "}
                  {owned.isActive ? "код включён" : "код выключен"} ·{" "}
                  {owned.programStatus}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(owned.code);
                      setNotice("Промокод скопирован.");
                    } catch {
                      setNotice(
                        "Не удалось скопировать автоматически. Выделите и скопируйте текст кода.",
                      );
                    }
                  }}
                >
                  Скопировать код
                </Button>
                {owned.currentTermsId && (
                  <Button
                    variant="outline"
                    disabled={
                      toggle.isPending ||
                      create.isPending ||
                      (!owned.isActive &&
                        (!accepted || owned.programStatus !== "active"))
                    }
                    onClick={async () => {
                      if (busy.current) return;
                      busy.current = true;
                      setNotice("");
                      try {
                        await toggle.mutateAsync({
                          userId,
                          productId,
                          codeId: owned.codeId,
                          isActive: !owned.isActive,
                        });
                      } catch (error) {
                        setNotice(
                          error instanceof Error
                            ? error.message
                            : "Изменение не подтверждено. Обновите список кодов.",
                        );
                      } finally {
                        busy.current = false;
                      }
                    }}
                  >
                    {owned.isActive ? "Отключить код" : "Включить код"}
                  </Button>
                )}
                {owned.currentTermsId && (
                  <Link
                    className="self-center text-sm underline"
                    href={
                      accepted
                        ? `/participant-portal/rules/${owned.currentTermsId}`
                        : `/participant-portal/join/${owned.programId}`
                    }
                    prefetch={false}
                  >
                    {accepted
                      ? "Условия программы"
                      : "Принять действующие правила"}
                  </Link>
                )}
              </div>
              {report &&
                !stats.isError &&
                (report.metrics.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">
                        Подтверждённые покупки и комиссии по коду {owned.code}
                      </caption>
                      <thead>
                        <tr>
                          <th className="p-2">Валюта</th>
                          <th className="p-2">Покупки</th>
                          <th className="p-2">Уплачено</th>
                          <th className="p-2">Ожидает одобрения</th>
                          <th className="p-2">Одобрено</th>
                          <th className="p-2">Отклонено</th>
                          <th className="p-2">Отмечено выданным</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.metrics.map((metric) => {
                          const money = new Intl.NumberFormat("ru-RU", {
                            style: "currency",
                            currency: metric.currency,
                          });
                          return (
                            <tr key={metric.currency}>
                              <td className="p-2">{metric.currency}</td>
                              <td className="p-2">{metric.paidPurchases}</td>
                              {[
                                metric.paidAmountMinor,
                                metric.pendingMinor,
                                metric.approvedMinor,
                                metric.rejectedMinor,
                                metric.disbursedMinor,
                              ].map((minor, index) => (
                                <td
                                  className="whitespace-nowrap p-2"
                                  key={index}
                                >
                                  {money.format(minor / 100)}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    За выбранный период подтверждённых покупок по коду нет.
                  </p>
                ))}
            </article>
          );
        })}
      </div>
      {!codes.length && (
        <p>Кодов пока нет. Подключитесь к разрешённой программе.</p>
      )}
      {!!programs.length && (
        <form
          className="max-w-xl space-y-3 rounded-xl border p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              busy.current ||
              !programId ||
              !availability.code ||
              (!availability.canSubmit && !uncertainRetry)
            )
              return;
            busy.current = true;
            setNotice("");
            try {
              const saved = await create.mutateAsync({
                userId,
                programId,
                code: availability.code,
              });
              setCode("");
              setNotice(
                `Промокод сохранён. Текущий статус — ${saved.isActive ? "включён" : "выключен"}.`,
              );
            } catch (error) {
              setNotice(
                error instanceof Error
                  ? `${error.message} Проверьте список кодов: сохранение могло завершиться до потери связи.`
                  : "Результат неизвестен. Обновите список кодов перед повтором.",
              );
            } finally {
              busy.current = false;
            }
          }}
        >
          <h3 className="font-medium">Дополнительный промокод</h3>
          {programs.length > 1 && (
            <label className="block text-sm">
              Программа
              <select
                className="block rounded border p-2"
                value={programId}
                onChange={(event) => setProgramChoice(event.target.value)}
              >
                <option value="">Выберите свою программу</option>
                {programs.map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <PartnerCodeField
            value={code}
            onChange={setCode}
            availability={availability}
            disabled={create.isPending}
          />
          <Button
            type="submit"
            disabled={
              create.isPending ||
              toggle.isPending ||
              !programId ||
              (!availability.canSubmit && !uncertainRetry)
            }
          >
            {create.isPending
              ? "Сохраняем…"
              : uncertainRetry
                ? "Повторить тот же запрос"
                : "Создать код"}
          </Button>
        </form>
      )}
      {!!acceptedRules.length && (
        <details>
          <summary>Принятые редакции правил</summary>
          <ul className="mt-2 space-y-2 text-sm">
            {acceptedRules.map((rule) => (
              <li key={rule.termsId}>
                <Link
                  className="underline"
                  href={`/participant-portal/rules/${rule.termsId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  prefetch={false}
                >
                  {rule.programName} — принято{" "}
                  {rule.acceptedAt.toLocaleString("ru-RU")}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        «Отмечено выданным» — статус начислений, не распределение общих выплат
        по кодам. Баланс, резерв и вывод учитываются отдельно по участнику и
        валюте.
      </p>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
