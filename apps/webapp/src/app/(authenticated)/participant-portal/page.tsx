"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useQueryState } from "nuqs";
import { PartnerCodesPanel } from "@/components/partner-codes-panel";
import { Textarea } from "@refref/ui/components/textarea";
import { api } from "@/trpc/react";
import { getQueryKey } from "@trpc/react-query";
import { useSession } from "@/lib/auth-client";
import { useDeniedRead } from "@/hooks/use-denied-read";
import { Button } from "@refref/ui/components/button";
import { Input } from "@refref/ui/components/input";
import { Skeleton } from "@refref/ui/components/skeleton";
import {
  currencySchema,
  RewardCurrencies,
  payoutRecipientInputSchema,
  type PayoutRecipientInput,
  type CurrencyType,
} from "@refref/types";

export default function ParticipantPortalPage() {
  const session = useSession();
  const userId =
    !session.isPending && !session.error ? (session.data?.user.id ?? "") : "";
  const memberships = api.participantPortal.memberships.useQuery(
    { userId },
    { enabled: !!userId },
  );
  const [selected, setSelected] = useQueryState("productId", {
    defaultValue: "",
  });
  const utils = api.useUtils();
  const membershipDeniedNow =
    memberships.error?.data?.code === "UNAUTHORIZED" ||
    memberships.error?.data?.code === "FORBIDDEN";
  const membershipDenied = useDeniedRead({
    scopeKey: userId,
    denied: membershipDeniedNow,
    queries: [memberships],
    reset: (queryClient) => {
      void utils.participantPortal.memberships.reset({ userId });
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.participantPortal.summary,
          { userId },
          "query",
        ),
      });
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.participantPortal.history,
          { userId },
          "query",
        ),
      });
    },
  });
  const candidate =
    selected ||
    (memberships.data?.length === 1 ? memberships.data[0]!.productId : "");
  const productId =
    !membershipDenied &&
    memberships.data?.some((m) => m.productId === candidate)
      ? candidate
      : "";
  return (
    <main className="max-w-5xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold">My referral earnings</h1>
      <p>
        Собственный подтверждённый аккаунт RefRef даёт доступ только к вашим
        кодам, начислениям и заявкам. Реквизиты требуются при выводе, не при
        подключении.
      </p>
      {userId && (
        <details>
          <summary>Идентификатор аккаунта RefRef</summary>
          <code>{userId}</code>
        </details>
      )}
      {session.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : !userId ? (
        <div role="alert">
          Session identity could not be verified.{" "}
          <Button onClick={() => void session.refetch()}>Retry session</Button>
          <Link href="/auth/sign-in" prefetch={false}>
            Sign in
          </Link>
        </div>
      ) : null}
      {userId &&
        (memberships.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : membershipDenied || memberships.isError ? (
          <div role="alert">
            Unable to load verified products.{" "}
            <Button
              disabled={memberships.isFetching}
              onClick={() => void memberships.refetch()}
            >
              Retry verified products
            </Button>
          </div>
        ) : (
          <label className="flex gap-3">
            Product
            <select
              className="border rounded p-2"
              value={productId}
              onChange={(e) => void setSelected(e.target.value)}
            >
              <option value="">Select verified product</option>
              {memberships.data?.map((m) => (
                <option key={m.productId} value={m.productId}>
                  {m.productName}
                </option>
              ))}
            </select>
          </label>
        ))}
      {userId &&
        !memberships.isLoading &&
        !memberships.isError &&
        !membershipDenied &&
        !memberships.data?.length && (
          <p>
            Вы ещё не подключились к программе. Откройте служебный адрес
            участия, войдите в RefRef и примите её действующие правила.
            Реквизиты пока не нужны.
          </p>
        )}
      {productId && userId && (
        <OwnedFinancialView
          key={`${userId}:${productId}`}
          userId={userId}
          productId={productId}
        />
      )}
    </main>
  );
}
function OwnedFinancialView({
  userId,
  productId,
}: {
  userId: string;
  productId: string;
}) {
  const [page, setPage] = useState(1);
  const summary = api.participantPortal.summary.useQuery({ userId, productId });
  const history = api.participantPortal.history.useQuery({
    userId,
    productId,
    page,
    pageSize: 20,
  });
  const [currency, setCurrency] = useState<CurrencyType>("RUB");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState<PayoutRecipientInput>({
    name: "",
    details: "",
  });
  const request = useRef<{
    key: string;
    amountMinor: number;
    currency: CurrencyType;
    recipient: PayoutRecipientInput;
  } | null>(null);
  const busy = useRef(false);
  const utils = api.useUtils();
  const payout = api.participantPortal.requestPayout.useMutation({
    onSettled: async () => {
      await Promise.all([
        utils.participantPortal.summary.invalidate({ userId, productId }),
        utils.participantPortal.history.invalidate({ userId, productId }),
        utils.payouts.list.invalidate({ productId }),
      ]);
    },
  });
  const [error, setError] = useState<string | null>(null);
  const accessDeniedNow = [summary.error, history.error, payout.error].some(
    (queryError) =>
      queryError?.data?.code === "UNAUTHORIZED" ||
      queryError?.data?.code === "FORBIDDEN",
  );
  const accessDenied = useDeniedRead({
    scopeKey: `${userId}:${productId}`,
    denied: accessDeniedNow,
    queries: [summary, history],
    reset: (queryClient) => {
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.participantPortal.summary,
          { userId, productId },
          "query",
        ),
        exact: true,
      });
      void queryClient.resetQueries({
        queryKey: getQueryKey(
          api.participantPortal.history,
          { userId, productId },
          "query",
        ),
      });
    },
    dispose: (queryClient) => {
      queryClient.removeQueries({
        queryKey: getQueryKey(
          api.participantPortal.summary,
          { userId, productId },
          "query",
        ),
        exact: true,
      });
      queryClient.removeQueries({
        queryKey: getQueryKey(
          api.participantPortal.history,
          { userId, productId },
          "query",
        ),
      });
    },
  });
  const submit = async () => {
    if (busy.current || accessDenied) return;
    const amountMinor = Number(amount);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      setError("Enter a positive integer minor amount");
      return;
    }
    const parsedRecipient = payoutRecipientInputSchema.safeParse(recipient);
    if (!parsedRecipient.success) {
      setError(
        "Укажите имя получателя и реквизиты: до 200 и 1000 символов соответственно.",
      );
      return;
    }
    busy.current = true;
    setError(null);
    if (
      !request.current ||
      request.current.amountMinor !== amountMinor ||
      request.current.currency !== currency ||
      request.current.recipient.name !== parsedRecipient.data.name ||
      request.current.recipient.details !== parsedRecipient.data.details
    )
      request.current = {
        key: crypto.randomUUID(),
        amountMinor,
        currency,
        recipient: parsedRecipient.data,
      };
    try {
      await payout.mutateAsync({
        userId,
        productId,
        amountMinor,
        currency,
        idempotencyKey: request.current.key,
        recipient: parsedRecipient.data,
      });
      request.current = null;
      setAmount("");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Payout request failed; retry keeps the same request identity",
      );
    } finally {
      busy.current = false;
    }
  };
  if (accessDenied)
    return (
      <div role="alert">
        Access to earnings could not be verified. Cached financial data is
        hidden.{" "}
        <Button
          disabled={
            summary.isFetching || history.isFetching || payout.isPending
          }
          onClick={async () => {
            const refreshed = await Promise.all([
              summary.refetch(),
              history.refetch(),
            ]);
            if (refreshed.every((query) => query.isSuccess)) payout.reset();
          }}
        >
          Retry verified access
        </Button>
        <Link href="/auth/sign-in" prefetch={false}>
          Sign in
        </Link>
      </div>
    );
  return (
    <div className="space-y-6">
      {summary.isLoading && !summary.data ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <>
          {summary.isError && (
            <p role="alert">
              Balance refresh failed. No financial success is assumed.
            </p>
          )}
          {summary.data && (
            <PartnerCodesPanel
              key={`${userId}:${productId}`}
              userId={userId}
              productId={productId}
              codes={summary.data.codes}
              acceptedRules={summary.data.acceptedRules}
            />
          )}
          <div
            className="overflow-x-auto"
            role="region"
            aria-label="Одобренный баланс"
            tabIndex={0}
          >
            <table className="w-full text-left">
              <caption>
                Approved cash balance (pending, rejected, discount and legacy
                disbursed earnings are not withdrawable)
              </caption>
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Eligible</th>
                  <th>Reserved</th>
                  <th>Completed</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {summary.data?.balances.map((b) => (
                  <tr key={b.currency}>
                    {[
                      b.currency,
                      b.eligibleMinor,
                      b.reservedMinor,
                      b.completedMinor,
                      b.availableMinor,
                    ].map((v, i) => (
                      <td key={i}>
                        {i === 0
                          ? v
                          : new Intl.NumberFormat(undefined, {
                              style: "currency",
                              currency: b.currency,
                            }).format(Number(v) / 100)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>All reward categories</summary>
            {summary.data?.categories.map((c, i) => (
              <p key={i}>
                {c.currency ?? "unspecified currency"} · {c.rewardType} ·{" "}
                {c.status}: {c.amount} ({c.count})
              </p>
            ))}
          </details>
          <p>
            Реквизиты указываются и подтверждаются вами для конкретной заявки.
            После создания заявки её получатель и сумма не изменяются.
          </p>
        </>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-wrap gap-3 items-end"
      >
        <label>
          Currency
          <select
            className="block border rounded p-2"
            value={currency}
            disabled={payout.isPending}
            onChange={(e) => setCurrency(currencySchema.parse(e.target.value))}
          >
            {RewardCurrencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Amount in minor units (RUB: kopecks)
          <Input
            type="number"
            min="1"
            step="1"
            disabled={payout.isPending}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Получатель
          <Input
            required
            autoComplete="name"
            maxLength={200}
            disabled={payout.isPending}
            value={recipient.name}
            onChange={(event) =>
              setRecipient((current) => ({
                ...current,
                name: event.target.value,
              }))
            }
          />
        </label>
        <label className="min-w-64 flex-1">
          Реквизиты для ручного перевода
          <Textarea
            required
            maxLength={1000}
            rows={3}
            disabled={payout.isPending}
            value={recipient.details}
            autoComplete="off"
            onChange={(event) =>
              setRecipient((current) => ({
                ...current,
                details: event.target.value,
              }))
            }
          />
        </label>
        {summary.data?.recipient && (
          <Button
            type="button"
            variant="outline"
            disabled={payout.isPending}
            onClick={() =>
              setRecipient({
                name: summary.data!.recipient!.name,
                details: summary.data!.recipient!.details,
              })
            }
          >
            Использовать сохранённые реквизиты
          </Button>
        )}
        <p className="w-full text-sm text-muted-foreground">
          Проверьте реквизиты перед отправкой. Не указывайте PIN, CVV, пароли
          или коды подтверждения. Это данные, предоставленные вами, не
          банковская верификация. Перевод выполняется администратором вручную.
        </p>
        <Button type="submit" disabled={payout.isPending || !summary.data}>
          Request payout
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {history.isLoading && !history.data ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          {history.isError && <p role="alert">History refresh failed.</p>}
          <h2 className="text-xl">Rewards</h2>
          <div
            className="overflow-x-auto"
            role="region"
            aria-label="История начислений"
            tabIndex={0}
          >
            <table className="w-full text-left">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {history.data?.rewards.map((r) => (
                  <tr key={r.id}>
                    <td>{r.createdAt.toLocaleString()}</td>
                    <td>{r.rewardType}</td>
                    <td>
                      {r.amount} {r.currency}
                    </td>
                    <td>{r.status}</td>
                    <td>{r.eventId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 className="text-xl">Payout requests</h2>
          <div
            className="overflow-x-auto"
            role="region"
            aria-label="Заявки на вывод"
            tabIndex={0}
          >
            <table className="w-full text-left">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Execution</th>
                  <th>Recipient</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {history.data?.payouts.map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td>
                      {new Intl.NumberFormat(undefined, {
                        style: "currency",
                        currency: p.currency,
                      }).format(p.amountMinor / 100)}
                    </td>
                    <td>{p.status}</td>
                    <td>{p.executionMethod ?? "not started"}</td>
                    <td className="max-w-xs break-words">
                      {p.recipient.name}
                      <br />
                      {p.recipient.details}
                    </td>
                    <td>{p.externalReference ?? "not confirmed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3">
            <Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span>Page {page}</span>
            <Button
              disabled={
                (history.data?.rewards.length ?? 0) < 20 &&
                (history.data?.payouts.length ?? 0) < 20
              }
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
