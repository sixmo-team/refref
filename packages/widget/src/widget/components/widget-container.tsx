import { useEffect } from "react";
import { Widget } from "./widget";
import { widgetStore } from "../../lib/store";
import { useStore } from "zustand";

export function WidgetContainer() {
  const { initialized, widgetElementSelector, setIsOpen } =
    useStore(widgetStore);

  useEffect(() => {
    if (!initialized) return;
    const triggers = new Set<Element>();
    const openWidget = () => setIsOpen(true);
    // Setup data attribute triggers
    const setupTriggers = () => {
      if (!widgetElementSelector) return;
      for (const element of triggers) {
        if (element.isConnected) continue;
        element.removeEventListener("click", openWidget);
        triggers.delete(element);
      }
      document.querySelectorAll(widgetElementSelector).forEach((element) => {
        if (triggers.has(element)) return;
        element.addEventListener("click", openWidget);
        triggers.add(element);
      });
    };

    setupTriggers();
    const observer = new MutationObserver(setupTriggers);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      for (const element of triggers) {
        element.removeEventListener("click", openWidget);
      }
    };
  }, [initialized, widgetElementSelector, setIsOpen]);

  if (!initialized) {
    return null;
  }

  return <Widget />;
}
