import type { NotificationConfigType } from "@refref/types";


export const defaultNotificationConfig: NotificationConfigType = {
  welcomeEmail: {
    enabled: false,
    subject: "",
    template: "",
  },
  successEmail: {
    enabled: false,
    subject: "",
    template: "",
  },
  inApp: {
    progressUpdates: false,
    rewardNotifications: false,
  },
};
