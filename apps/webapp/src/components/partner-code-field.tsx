"use client";
import { useId } from "react";
import { Input } from "@refref/ui/components/input";
import { Label } from "@refref/ui/components/label";
import { Button } from "@refref/ui/components/button";
import type { PartnerCodeAvailability } from "@/hooks/use-partner-code";

export function PartnerCodeField({
  value,
  onChange,
  availability,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  availability: PartnerCodeAvailability;
  disabled?: boolean;
}) {
  const id = useId();
  const message = {
    empty:
      "От 3 до 32 латинских букв или цифр, например ANNA10. Регистр не имеет значения.",
    invalid:
      "Нужны 3–32 латинские буквы или цифры; зарезервированные и недопустимые тексты не принимаются.",
    checking: "Проверяем доступность…",
    available:
      "Код доступен для сохранения. Доступность повторно проверяется на сервере.",
    taken:
      "Этот промокод уже занят. Измените текст — случайная замена не выполняется.",
    unavailable:
      "Проверка сейчас недоступна. Повторите её; ошибку не считаем свободным кодом.",
  }[availability.status];
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Промокод</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={64}
        required
        disabled={disabled}
        aria-describedby={`${id}-status`}
        aria-invalid={
          availability.status === "invalid" || availability.status === "taken"
        }
      />
      <p
        id={`${id}-status`}
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        {message}
      </p>
      {availability.status === "unavailable" && (
        <Button
          type="button"
          variant="outline"
          onClick={() => void availability.retry()}
          disabled={disabled}
        >
          Повторить проверку
        </Button>
      )}
    </div>
  );
}
