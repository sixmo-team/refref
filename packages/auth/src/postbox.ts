import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface PostboxConfig {
  /** RefRef's own verified sender. No sender or credentials are borrowed from another service. */
  from?: string;
  /** Omit to use the official Node credential provider chain. */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

export function postboxConfigFromEnv(environment: {
  REFREF_POSTBOX_FROM?: string;
  REFREF_POSTBOX_ACCESS_KEY_ID?: string;
  REFREF_POSTBOX_SECRET_ACCESS_KEY?: string;
  REFREF_POSTBOX_SESSION_TOKEN?: string;
  [key: string]: unknown;
}): PostboxConfig {
  const accessKeyId = environment.REFREF_POSTBOX_ACCESS_KEY_ID;
  const secretAccessKey = environment.REFREF_POSTBOX_SECRET_ACCESS_KEY;
  const sessionToken = environment.REFREF_POSTBOX_SESSION_TOKEN;
  return {
    from: environment.REFREF_POSTBOX_FROM,
    ...(accessKeyId || secretAccessKey || sessionToken
      ? {
          credentials: {
            accessKeyId: accessKeyId ?? "",
            secretAccessKey: secretAccessKey ?? "",
            ...(sessionToken ? { sessionToken } : {}),
          },
        }
      : {}),
  };
}

export async function sendPostboxEmail(
  client: SESv2Client,
  config: PostboxConfig | undefined,
  message: { to: string; subject: string; html: string },
): Promise<void> {
  if (
    !config?.from?.trim() ||
    /[\r\n]/.test(config.from) ||
    (config.credentials &&
      (!config.credentials.accessKeyId.trim() ||
        !config.credentials.secretAccessKey.trim()))
  ) {
    throw new Error("Email delivery is not configured");
  }
  try {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: config.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: { Html: { Data: message.html, Charset: "UTF-8" } },
          },
        },
      }),
    );
  } catch {
    // Provider diagnostics may contain recipients, credentials or bearer links. Never surface them.
    throw new Error("Email delivery failed");
  }
}
