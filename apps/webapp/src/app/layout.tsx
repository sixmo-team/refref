import "@/styles/app.css";
import Script from "next/script";
import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";
import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { TRPCReactProvider } from "@/trpc/react";
import { AuthUIProvider } from "@/components/providers/auth-ui-provider";

export const metadata: Metadata = {
  title: "RefRef - Referral Management Platform",
  description:
    "RefRef is an open source referral marketing platform that helps you launch and manage powerful referral programs in minutes. Drive customer acquisition through word-of-mouth marketing with customizable rewards, analytics, and seamless integration.",
  icons: [
    { rel: "icon", url: "/logo.svg", type: "image/svg+xml" },
    { rel: "apple-touch-icon", url: "/logo.svg" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={GeistSans.variable}
      suppressHydrationWarning
    >
      <head>
        <Script
          suppressHydrationWarning
          src="/assets/attribution.v1.js"
          strategy="afterInteractive"
        />
        <Script
          id="refref-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              window.RefRef = window.RefRef || [];
            `,
          }}
        />
        <Script
          suppressHydrationWarning
          src="/assets/widget.v1.js"
          strategy="afterInteractive"
        />
      </head>
      <body suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TRPCReactProvider>
            <AuthUIProvider>
              <NuqsAdapter>{children}</NuqsAdapter>
            </AuthUIProvider>
          </TRPCReactProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
