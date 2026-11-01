import { Badge } from "@/components/ui/badge";
import { SubscriptionForm } from "@/components/ui/subscription-form";
import Image from "next/image";
export type ChangelogEntry = {
  version: string;
  date: string;
  title: string;
  description: string;
  items?: string[];
  image?: string;
};

export interface ChangelogProps {
  title?: string;
  description?: string;
  entries?: ChangelogEntry[];
  className?: string;
}

const Changelog = ({
  title = "Changelog",
  description = "Get the latest product updates and changes to RefRef.",
  entries = defaultChangelogData,
}: ChangelogProps) => {
  return (
    <section className="py-32">
      <div className="container">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="mb-4 text-3xl font-bold tracking-tight md:text-5xl">
            {title}
          </h1>
          <p className="mb-6 text-base text-muted-foreground md:text-lg">
            {description}
          </p>
        </div>
        <SubscriptionForm
          variant="blog"
          formName="changelog_subscription"
          redirectUrl="https://refref.ai/changelog?submission=true&form_type=subscribe"
          showHeader={false}
        />
        <div className="mx-auto mt-16 max-w-3xl space-y-16 md:mt-24 md:space-y-24">
          {entries.map((entry, index) => (
            <div
              key={index}
              className="relative flex flex-col gap-4 md:flex-row md:gap-16"
            >
              <div className="top-28 flex h-min shrink-0 items-center gap-4 md:sticky">
                <Badge variant="secondary" className="text-xs">
                  {entry.version}
                </Badge>
                <span className="text-xs font-medium text-muted-foreground">
                  {entry.date}
                </span>
              </div>
              <div>
                <h2 className="mb-3 text-lg leading-tight font-bold text-foreground/90 md:text-2xl">
                  {entry.title}
                </h2>
                <p className="text-sm text-muted-foreground md:text-base">
                  {entry.description}
                </p>
                {entry.items && entry.items.length > 0 && (
                  <ul className="mt-4 ml-4 space-y-1.5 text-sm text-muted-foreground md:text-base">
                    {entry.items.map((item, itemIndex) => (
                      <li key={itemIndex} className="list-disc">
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
                {entry.image && (
                  <Image
                    src={entry.image}
                    alt={`${entry.version} visual`}
                    width={1200}
                    height={600}
                    unoptimized
                    className="mt-8 h-auto w-full rounded-lg object-cover"
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Changelog;

export const defaultChangelogData: ChangelogEntry[] = [
  {
    version: "Unreleased — activation gated",
    date: "22 October 2026",
    title: "Native first-referral-payment tracking and manual payouts",
    description:
      "Implementation for coordinated acceptance; not a production program activation or a claim of completed bank verification.",
    items: [
      "Shared Single-Sided/Double-Sided configuration, exact versioned money and RUB alongside existing currencies.",
      "Protected read-only code resolution and atomic snapshot-based purchase tracking, preserving legacy major-unit consumers.",
      "Existing Activity extended with purchase amount, code and native attribution; verified own earnings and provider-neutral manual payout requests.",
      "Explicit business/ownership approval, scoped financial history, reservations and manual payment/refund review before payout.",
      "Retain ordinary Single-Sided V1 activation and original API/web percentage fallbacks; reward-only saves preserve custom design and rules.",
      "Forward the manual execution namespace through native Turbo runtime environment handling, without weakening scoped financial approval.",
      "Encapsulate template validation, form mapping and rule capabilities in the existing static registry; keep first-paid versus recurring policy programme-specific.",
      "Support independently enabled buyer-only discounts with explicit currency and no synthetic cash reward; promoters need only a verified RefRef identity, not an AI-marketer account.",
      "Add administrator-assisted RefRef-account enrollment and own program-code display without backend membership, SQL fixtures or email-based ownership matching.",
      "Scope the browser query-client lifecycle to session user/organization, including logout and late responses, while preserving same-session drafts and initial Suspense loads.",
      "Preserve original V1 API/web coupon policies explicitly, and keep global RefRef profile PII out of administrator-assisted program enrollment.",
      "Preserve signed V1 cash and debt balances without weakening V2 amounts or payout backing; reject incompatible custom commission conversion before activation.",
      "Separate cold static loading from authenticated gateway quotas while retaining rate/connection limits and a native regression check.",
      "Use native Better Auth expiry options and mutation/error handling for scoped key setup, with visible settings feedback and accurate key-scope/accessibility labels.",
      "Patch native fast-uri normalization within existing 3.x/4.x branches after an actual encoded-scheme reproduction; keep unrelated dependency versions unchanged.",
      "Align the builder heap with the existing 2 GiB bounded mode without increasing hard controller or runtime resource limits.",
    ],
  },
  {
    version: "Version 0.1.0",
    date: "28 April 2025",
    title: "RefRef 0.1 coming soon!",
    description:
      "First version of RefRef is coming soon by end of April 2025! What to expect:",
    items: [
      "Refer-a-friend program",
      "Single or double sided rewards",
      "Pre-built referral UI components",
      "Referral Attribution SDK",
      "Referral tracking",
      "Rewards tracking",
    ],
    image:
      "https://placehold.co/1200x600/6b46c1/ffffff?text=Announcing+RefRef+0.1",
  },
];
