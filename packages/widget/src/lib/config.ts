import { WidgetConfigType } from "@refref/types";

export const defaultConfig: WidgetConfigType = {
  position: "bottom-left",
  triggerText: "Refer & Earn",
  icon: "gift",
  title: "Invite your friends",
  subtitle: "Share your referral link and earn rewards when your friends join!",
  logoUrl: "",
  shareMessage: "Join me on {productName} and get a reward!",
  enabledPlatforms: {
    facebook: true,
    twitter: true,
    linkedin: true,
    whatsapp: true,
    email: true,
    instagram: false,
    telegram: false,
  },
  referralLink: "https://i.refref.ai/<ref_code>",
  productName: "YourSaaS",
};
