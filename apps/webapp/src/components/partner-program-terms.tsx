import type { RewardConfigType, FrozenCommission } from "@refref/types";

export function PartnerProgramTerms({
  terms,
  commission,
  startDate,
  endDate,
}: {
  terms: RewardConfigType;
  commission: FrozenCommission;
  startDate?: Date | null;
  endDate?: Date | null;
}) {
  const referrer = terms.referrer;
  const buyer = terms.referee;
  return (
    <section
      className="space-y-3 rounded-xl border bg-muted/30 p-4"
      aria-label="Условия программы"
    >
      <h2 className="text-lg font-semibold">Условия программы</h2>
      <p>
        {terms.firstPaidOnly
          ? "Учитывается первая подходящая подтверждённая оплата плательщика, а не каждого сотрудника или рабочего пространства."
          : "Учитываются подходящие подтверждённые покупки по правилам этой программы."}
      </p>
      {commission.rules.length ? (
        <div className="space-y-2">
          <p>
            Вознаграждение рассчитывается по всем перечисленным правилам;
            подходящие начисления суммируются.{" "}
            {commission.basis === "payable_amount"
              ? "База — фактически уплаченная сумма после скидки."
              : "База — стоимость покупки до скидки."}
          </p>
          <ul className="list-inside list-disc space-y-2">
            {commission.rules.map((rule) => (
              <li key={rule.ruleId}>
                {rule.config.reward.unit === "percent"
                  ? `${rule.config.reward.amount}% от указанной базы`
                  : `${new Intl.NumberFormat("ru-RU", { style: "currency", currency: rule.config.reward.currency }).format(rule.config.reward.amount)} за подходящую покупку`}
                .
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p>
          Денежное вознаграждение рефереру не предусмотрено этими условиями.
        </p>
      )}
      <p>
        {buyer
          ? `Скидка покупателю: ${buyer.valueType === "percentage" ? `${buyer.value}%` : `${buyer.value} ${buyer.currency ?? "(валюта ещё не настроена)"}`}.${buyer.minPurchaseAmount ? ` Минимальная стоимость покупки: ${buyer.minPurchaseAmount} ${buyer.currency ?? referrer?.currency ?? ""}.` : ""}${buyer.validityDays ? ` Срок скидки — ${buyer.validityDays} дней от начала программы.` : ""}`
          : "Скидка покупателю не предусмотрена: действующий код учитывает привлечение при полной цене."}
      </p>
      {(startDate || endDate) && (
        <p>
          Период программы:{" "}
          {startDate
            ? startDate.toLocaleString("ru-RU", { timeZone: "UTC" })
            : "без даты начала"}
          {" — "}
          {endDate
            ? endDate.toLocaleString("ru-RU", { timeZone: "UTC" })
            : "без даты окончания"}{" "}
          (UTC).
        </p>
      )}
      <p>
        Начисление сначала ожидает одобрения. Вывод одобренного доступного
        остатка оформляется в RefRef; организатор переводит деньги вручную.
        Реквизиты нужны при выводе, не при подключении.
      </p>
    </section>
  );
}
