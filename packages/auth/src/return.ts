/** A return destination is navigation context, never an identity or authorization grant. */
export function getAuthReturnPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\p{Cc} ]/u.test(value) ||
    /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value.split(/[?#]/, 1)[0]!)
  )
    return undefined;
  try {
    const url = new URL(value, "https://internal.invalid");
    if (
      url.origin !== "https://internal.invalid" ||
      `${url.pathname}${url.search}${url.hash}` !== value
    )
      return undefined;
    if (
      /^\/participant-portal\/join(?:\/|$)/.test(url.pathname) &&
      !/^\/participant-portal\/join\/[A-Za-z0-9_-]+$/.test(value)
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Native Better Auth UI sends absolute same-origin callbacks; nested returns stay relative. */
export function validateAuthCallback(value: unknown, baseURL: string): void {
  if (value === undefined || value === "") return;
  if (typeof value !== "string" || /[\\\p{Cc} ]/u.test(value)) {
    throw new Error("Invalid authentication return destination");
  }
  try {
    const base = new URL(baseURL);
    if (!value.startsWith("/") && !/^https?:\/\//.test(value))
      throw new Error();
    const url = new URL(value, base);
    const path = value.startsWith("/")
      ? value
      : `${url.pathname}${url.search}${url.hash}`;
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      !getAuthReturnPath(path)
    )
      throw new Error();
    for (const key of ["redirectTo", "callbackURL"]) {
      const destinations = url.searchParams.getAll(key);
      if (
        destinations.length > 1 ||
        destinations.some((destination) => !getAuthReturnPath(destination))
      )
        throw new Error();
    }
  } catch {
    throw new Error("Invalid authentication return destination");
  }
}
