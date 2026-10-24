import { parseCookies } from "better-call";

/**
 * Cookie utilities for extracting referral codes from HTTP requests
 */

/**
 * Extract referral code from request headers
 */
export function extractRefcodeFromRequest(
  request: Request | { headers?: Headers | Record<string, string> },
  cookieName: string = "refref-refcode",
): string | undefined {
  let cookieString: string | undefined;

  // Handle different request formats
  if ("headers" in request && request.headers) {
    if (request.headers instanceof Headers) {
      // Standard Headers object
      cookieString = request.headers.get("cookie") || undefined;
    } else if (typeof request.headers === "object") {
      // Plain object headers
      cookieString = request.headers["cookie"] || request.headers["Cookie"];
    }
  }

  if (!cookieString) {
    return undefined;
  }

  return parseCookies(cookieString).get(cookieName) || undefined;
}

/**
 * Read the endpoint's effective headers, including direct server API calls
 * which do not construct a Request.
 */
export function extractRefcodeFromContext(
  context: {
    request?: Request | { headers?: Headers | Record<string, string> };
    headers?: Headers | Record<string, string>;
  },
  cookieName?: string,
): string | undefined {
  return extractRefcodeFromRequest(
    context.headers ? context : (context.request ?? context),
    cookieName,
  );
}
