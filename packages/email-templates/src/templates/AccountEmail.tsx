import * as React from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

function AccountEmail({
  url,
  title,
  description,
  action,
  ignored,
}: {
  url: string;
  title: string;
  description: string;
  action: string;
  ignored: string;
}) {
  return (
    <Html>
      <Head />
      <Preview>{title} — RefRef</Preview>
      <Body
        style={{
          backgroundColor: "#fafafa",
          fontFamily: "Arial, sans-serif",
          padding: "32px 16px",
        }}
      >
        <Container
          style={{
            backgroundColor: "#ffffff",
            maxWidth: "600px",
            padding: "32px",
            borderRadius: "12px",
          }}
        >
          <Text style={{ fontSize: "24px", fontWeight: "600" }}>RefRef</Text>
          <Heading>{title}</Heading>
          <Text>{description}</Text>
          <Section style={{ margin: "24px 0" }}>
            <Button
              href={url}
              style={{
                backgroundColor: "#18181b",
                color: "#ffffff",
                padding: "12px 24px",
                borderRadius: "6px",
              }}
            >
              {action}
            </Button>
          </Section>
          <Text>If the button does not work, open this link:</Text>
          <Link href={url} style={{ wordBreak: "break-all" }}>
            {url}
          </Link>
          <Text>
            This link expires. If it no longer works, request a new one from
            RefRef.
          </Text>
          <Text>{ignored}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function VerificationEmail({ url }: { url: string }) {
  return (
    <AccountEmail
      url={url}
      title="Verify your email address"
      action="Verify email"
      description="Confirm this email address for your RefRef account. This does not join a partner programme or accept its rules."
      ignored="If you did not request this, you can ignore this email. No account is verified by receiving this message alone."
    />
  );
}

export function ResetPasswordEmail({ url }: { url: string }) {
  return (
    <AccountEmail
      url={url}
      title="Reset your password"
      action="Reset password"
      description="A password reset was requested for your RefRef account. Open this link to choose a new password."
      ignored="If you did not request this, ignore this email. Your password has not changed."
    />
  );
}
