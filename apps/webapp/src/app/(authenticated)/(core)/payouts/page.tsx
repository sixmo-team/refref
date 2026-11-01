"use client";
import { useRef, useState } from "react";
import { AuthorizedProductScope } from "@/components/authorized-product-scope";
import { api, type RouterInputs, type RouterOutputs } from "@/trpc/react";
import { Button } from "@refref/ui/components/button";
import { Input } from "@refref/ui/components/input";
import { Skeleton } from "@refref/ui/components/skeleton";
import { currencySchema } from "@refref/types";
import { useDeniedRead } from "@/hooks/use-denied-read";

export default function PayoutsPage() {
  return (
    <section className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Payout requests</h1>
      <p>
        Manual execution only. Claim before transferring. Check the originating
        checkout/event in the backend and confirm actual payment and absence of
        a refund before transfer. Unknown transfer outcome stays processing: do
        not repeat a transfer or release its reserve.
      </p>
      <AuthorizedProductScope adminOnly>
        {(scope) => <PayoutAdministration {...scope} />}
      </AuthorizedProductScope>
    </section>
  );
}
function PayoutAdministration({
  productId,
  userId,
  organizationId,
}: {
  productId: string;
  userId: string;
  organizationId: string;
}) {
  const utils = api.useUtils();
  const [page, setPage] = useState(1);
  const list = api.payouts.list.useQuery({
    productId,
    userId,
    organizationId,
    page,
    pageSize: 20,
  });
  const blocked = useDeniedRead({
    scopeKey: JSON.stringify([userId, organizationId, productId]),
    denied:
      list.error?.data?.code === "UNAUTHORIZED" ||
      list.error?.data?.code === "FORBIDDEN",
    queries: [list],
    reset: () =>
      void utils.payouts.list.reset({ userId, organizationId, productId }),
  });
  if (blocked)
    return (
      <div role="alert">
        Payout access denied.{" "}
        <Button onClick={() => void list.refetch()}>Retry</Button>
      </div>
    );
  return (
    <div className="space-y-6">
      <OwnershipVerification productId={productId} />
      {list.isLoading && !list.data ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          {list.isError && (
            <div role="alert">
              Payout list refresh failed.{" "}
              <Button
                variant="outline"
                disabled={list.isFetching}
                onClick={() => void list.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {list.data?.data.map((payout) => (
            <PayoutRow
              key={payout.id}
              payout={payout}
              userId={userId}
              organizationId={organizationId}
            />
          ))}
          <div className="flex gap-3">
            <Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span>Page {page}</span>
            <Button
              disabled={page * 20 >= (list.data?.total ?? 0)}
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
function OwnershipVerification({ productId }: { productId: string }) {
  const utils = api.useUtils();
  const mutationOptions = {
    onSettled: async (
      _data: unknown,
      _error: unknown,
      variables: Pick<
        RouterInputs["payouts"]["verifyOwnership"],
        "ownerUserId" | "productId"
      >,
    ) => {
      const ownerScope = {
        userId: variables.ownerUserId,
        productId: variables.productId,
      };
      await Promise.all([
        utils.participantPortal.memberships.invalidate({
          userId: variables.ownerUserId,
        }),
        utils.participantPortal.summary.invalidate(ownerScope),
        utils.participantPortal.history.invalidate(ownerScope),
        utils.rewards.getAll.invalidate({
          scope: { productId: variables.productId },
        }),
      ]);
    },
  };
  const mutation = api.payouts.verifyOwnership.useMutation(mutationOptions);
  const enrollment = api.payouts.enrollReferrer.useMutation(mutationOptions);
  const [mode, setMode] = useState<"enroll" | "existing">("enroll");
  const busy = useRef(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState({
    participantId: "",
    programId: "",
    ownerUserId: "",
    evidence: "",
  });
  return (
    <details className="border rounded p-4">
      <summary>
        Verify participant ownership or enroll a RefRef referrer (administrator)
      </summary>
      <p>
        Verify that this participant belongs to the email-verified RefRef
        person. Transfer details are supplied by the participant when requesting
        a payout. The referrer does not need an AI-marketer backend account or
        subscription. Email similarity, signup and widget tokens alone are not
        evidence. Existing verified financial ownership cannot be reassigned
        here. For account enrollment, use the RefRef account ID shown in the
        person&apos;s own portal and an active program ID. This creates no
        backend account or organization membership.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy.current || !verified) return;
          busy.current = true;
          setError(null);
          const input = {
            productId,
            ownerUserId: fields.ownerUserId,
            evidence: fields.evidence,
            externalOwnershipVerified: true as const,
          };
          const callbacks = {
            onSuccess: () => setVerified(false),
            onError: (error: { message: string }) =>
              setError(error.message || "Ownership verification failed"),
            onSettled: () => {
              busy.current = false;
            },
          };
          if (mode === "enroll")
            enrollment.mutate(
              { ...input, programId: fields.programId },
              callbacks,
            );
          else
            mutation.mutate(
              { ...input, participantId: fields.participantId },
              callbacks,
            );
        }}
      >
        <label className="block">
          Verification operation
          <select
            className="block border rounded p-2"
            value={mode}
            disabled={mutation.isPending || enrollment.isPending}
            onChange={(event) => {
              setMode(
                event.target.value === "existing" ? "existing" : "enroll",
              );
              setVerified(false);
            }}
          >
            <option value="enroll">
              Enroll verified RefRef account and assign program code
            </option>
            <option value="existing">
              Verify an existing native participant
            </option>
          </select>
        </label>
        {(
          [
            ...(mode === "enroll"
              ? ([["programId", "Active program ID"]] as const)
              : ([["participantId", "Native participant ID"]] as const)),
            ["ownerUserId", "Verified RefRef account ID"],
            [
              "evidence",
              "Participant ownership evidence reference (no secrets)",
            ],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="block">
            {label}
            <Input
              required
              maxLength={key === "evidence" ? 500 : 200}
              value={fields[key]}
              onChange={(e) =>
                setFields((f) => ({ ...f, [key]: e.target.value }))
              }
            />
          </label>
        ))}
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
          />
          I independently verified participant ownership and the RefRef account
          identity
        </label>
        <Button
          disabled={!verified || mutation.isPending || enrollment.isPending}
        >
          {mode === "enroll"
            ? "Enroll verified referrer"
            : "Record verified ownership"}
        </Button>
        {mode === "existing" && mutation.isSuccess && (
          <p>Ownership recorded.</p>
        )}
        {mode === "enroll" && enrollment.isSuccess && (
          <p role="status">
            Assigned code <code>{enrollment.data.code}</code> for program{" "}
            {enrollment.data.programId}. The referrer can read it in their own
            portal.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
function PayoutRow({
  payout,
  userId,
  organizationId,
}: {
  payout: RouterOutputs["payouts"]["list"]["data"][number];
  userId: string;
  organizationId: string;
}) {
  const utils = api.useUtils();
  const resourceOptions = {
    onMutate: () => ({ userId, organizationId }),
    onSettled: (
      _data: unknown,
      _error: unknown,
      input: RouterInputs["payouts"]["claim"],
      originatingScope:
        | Pick<RouterInputs["payouts"]["list"], "userId" | "organizationId">
        | undefined,
    ) => {
      if (!originatingScope) return;
      void utils.payouts.list.invalidate({
        ...originatingScope,
        productId: input.productId,
      });
      void utils.participantPortal.summary.invalidate({
        productId: input.productId,
      });
      void utils.participantPortal.history.invalidate({
        productId: input.productId,
      });
    },
  };
  const claim = api.payouts.claim.useMutation(resourceOptions);
  const confirm = api.payouts.confirmPaid.useMutation(resourceOptions);
  const reject = api.payouts.reject.useMutation(resourceOptions);
  const busy = useRef(false);
  const confirmationKey = useRef(crypto.randomUUID());
  const [reference, setReference] = useState("");
  const [time, setTime] = useState("");
  const [paymentVerified, setPaymentVerified] = useState(false);
  const [notExecuted, setNotExecuted] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const callbacks = {
    onError: (error: { message: string }) =>
      setError(error.message || "Payout action failed"),
    onSettled: () => {
      busy.current = false;
    },
  };
  const pending = claim.isPending || confirm.isPending || reject.isPending;
  return (
    <section className="border rounded p-4 space-y-3">
      <h2 className="font-semibold">
        {payout.id} · {payout.status} ·{" "}
        {new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: payout.currency,
        }).format(payout.amountMinor / 100)}
      </h2>
      <p>
        Participant {payout.participantId}; requested{" "}
        {payout.createdAt.toLocaleString()}; assigned{" "}
        {payout.assignedTo ?? "none"}
      </p>
      <p>
        Frozen recipient: {payout.recipient.name} — {payout.recipient.details}
      </p>
      {payout.status === "requested" && (
        <Button
          disabled={pending}
          onClick={() => {
            if (busy.current) return;
            busy.current = true;
            setError(null);
            claim.mutate(
              { productId: payout.productId, payoutId: payout.id },
              callbacks,
            );
          }}
        >
          Claim for manual execution
        </Button>
      )}
      {payout.status === "processing" && payout.assignedTo === userId && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy.current || !paymentVerified || !time) return;
            const currency = currencySchema.safeParse(payout.currency);
            if (!currency.success) {
              setError("Unsupported payout currency");
              return;
            }
            const completedAt = new Date(time);
            if (!Number.isFinite(completedAt.getTime())) {
              setError("Enter a valid completion time");
              return;
            }
            busy.current = true;
            setError(null);
            confirm.mutate(
              {
                productId: payout.productId,
                payoutId: payout.id,
                amountMinor: payout.amountMinor,
                currency: currency.data,
                externalReference: reference,
                completedAt: completedAt.toISOString(),
                idempotencyKey: confirmationKey.current,
                paymentAndNoRefundVerified: true,
              },
              callbacks,
            );
          }}
        >
          <label className="block">
            Actual external transfer reference
            <Input
              required
              maxLength={200}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label className="block">
            Actual completion time (local)
            <Input
              required
              type="datetime-local"
              step="0.001"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={paymentVerified}
              onChange={(e) => setPaymentVerified(e.target.checked)}
            />
            I checked actual originating payment, no refund/dispute, and
            completed the exact transfer
          </label>
          <Button disabled={pending || !paymentVerified}>
            Confirm completed transfer (does not send money)
          </Button>
        </form>
      )}
      {(payout.status === "requested" ||
        (payout.status === "processing" && payout.assignedTo === userId)) && (
        <div className="space-y-2">
          <label>
            Rejection reason
            <Input
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {payout.status === "processing" && (
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={notExecuted}
                onChange={(e) => setNotExecuted(e.target.checked)}
              />
              I verified no transfer was executed and cannot later complete
              (unknown is not sufficient)
            </label>
          )}
          <Button
            variant="outline"
            disabled={
              pending ||
              !reason ||
              (payout.status === "processing" && !notExecuted)
            }
            onClick={() => {
              if (busy.current) return;
              busy.current = true;
              setError(null);
              reject.mutate(
                {
                  productId: payout.productId,
                  payoutId: payout.id,
                  reason,
                  transferNotExecutedVerified: notExecuted,
                },
                callbacks,
              );
            }}
          >
            Reject and release reservation
          </Button>
        </div>
      )}
      {payout.externalReference && (
        <p>
          Confirmed {payout.executionMethod}/{payout.provider}:{" "}
          {payout.externalReference}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <details>
        <summary>Transition audit</summary>
        {payout.audit.map((a, i) => (
          <p key={i}>
            {a.at} · {a.status} · {a.actorId} {a.reason}
          </p>
        ))}
      </details>
    </section>
  );
}
