export type ErrorDiagnostic = {
  type: "Error";
  message: "Operation failed";
  stack: "";
  code?: string;
};

const emptyDiagnostic: ErrorDiagnostic = Object.freeze({
  type: "Error",
  message: "Operation failed",
  stack: "",
});
const emptyRequest = Object.freeze({});

/** Never retain original error messages, stacks, SQL, parameters or causes. */
export function safeError(error: unknown): ErrorDiagnostic {
  if (!error || typeof error !== "object") return emptyDiagnostic;
  const cause = "cause" in error ? error.cause : undefined;
  const code =
    ("code" in error ? error.code : undefined) ??
    (cause && typeof cause === "object" && "code" in cause
      ? cause.code
      : undefined);
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? { type: "Error", message: "Operation failed", stack: "", code }
    : emptyDiagnostic;
}

export const safeLogSerializers = {
  err: safeError,
  error: safeError,
  req: () => emptyRequest,
};
