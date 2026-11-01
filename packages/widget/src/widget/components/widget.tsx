import { widgetStore } from "../../lib/store";
import { ReferralWidgetPresentation } from "@refref/ui/components/referral-widget/referral-widget-presentation";
import { useState } from "react";
import { useStore } from "zustand";

export function Widget() {
  const { isOpen, setIsOpen, config } = useStore(widgetStore);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

  if (!config) {
    return null;
  }


  return (
    <>
      <div ref={setPortalContainer} id="widget-portal-container" />
      {portalContainer && (
        <ReferralWidgetPresentation
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          config={config}
          container={portalContainer}
        />
      )}
    </>
  );
}
