import {
  widgetConfigSchema,
  type WidgetConfigType,
  type WidgetInitRequestType,
} from "@refref/types";
import { widgetStore } from "./store";

export interface RefRef {
  init: (params: {
    productId: string;
    participantId: string;
    token?: string;
    demo?: boolean;
    apiUrl?: string;
    programId?: string;
  }) => Promise<void>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: boolean;
  setConfig: (config: Partial<WidgetConfigType>) => void;
  getConfig: () => WidgetConfigType;
}

export type RefRefCommand = [keyof RefRef, ...unknown[]];

export interface RefRefClient extends RefRef {
  push: (command: RefRefCommand) => void;
}

// Helper function to safely parse cookies
function getCookie(name: string): string | null {
  const value = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`))
    ?.split("=")[1];

  return value ? decodeURIComponent(value) : null;
}

// Define the store state type
class RefRefImpl implements RefRef {
  private static instance: RefRefImpl;
  private store: typeof widgetStore;

  private constructor() {
    // Get the raw store API without the React hooks
    this.store = widgetStore;
  }

  static getInstance(): RefRefImpl {
    if (!RefRefImpl.instance) {
      RefRefImpl.instance = new RefRefImpl();
    }
    return RefRefImpl.instance;
  }

  async init({
    productId,
    participantId,
    token,
    apiUrl,
  }: {
    productId: string;
    participantId: string;
    token?: string;
    apiUrl?: string;
  }) {
    try {
      // Normal mode: make API call
      // Check for referral code (refcode) to enable auto-attribution
      // 1. Query string parameters (freshest intent, works even with cookies blocked, available in SSR)
      // 2. Cookie (persistent across sessions and page navigations, but may be blocked by privacy settings)
      const urlParams = new URLSearchParams(window.location.search);
      const refcodeFromQuery = urlParams.get("refcode");
      const refcodeFromCookie = getCookie("refref-refcode");

      // Query string takes priority as it represents the most recent referral click
      const refcode = refcodeFromQuery || refcodeFromCookie || undefined;

      // Use provided apiUrl or fall back to build-time configured URL
      const baseUrl = apiUrl ?? import.meta.env.VITE_REFREF_API_ENDPOINT!;
      const widgetInitUrl = `${baseUrl}/v1/widget/init`;

      const response = await fetch(widgetInitUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          productId,
          refcode,
        } satisfies WidgetInitRequestType),
      });

      if (!response.ok) {
        const error: unknown = await response.json();
        throw new Error(
          typeof error === "object" && error !== null &&
          "error" in error && typeof error.error === "string"
            ? error.error || "Failed to initialize widget"
            : "Failed to initialize widget",
        );
      }

      const data = widgetConfigSchema.parse(await response.json());

      this.store.setState({
        initialized: true,
        token,
        participantId,
        productId,
        config: {
          ...data,
        },
      });


      // this.setConfig(data);
    } catch (error) {
      console.error("Failed to initialize RefRef widget");
      throw error;
    }
  }

  open() {
    this.store.setState({ isOpen: true });
  }

  close() {
    this.store.setState({ isOpen: false });
  }

  toggle() {
    this.store.setState((state) => ({ isOpen: !state.isOpen }));
  }

  get isOpen() {
    return this.store.getState().isOpen;
  }

  setConfig(config: Partial<WidgetConfigType>) {
    this.store.setState((state) => ({
      config: { ...state.config, ...config },
    }));
  }

  getConfig(): WidgetConfigType {
    return this.store.getState().config;
  }
}

// Initialize RefRef on window
// Hybrid proxy pattern: supports both .push and method calls forever

declare global {
  interface Window {
    RefRef: RefRefClient | RefRefCommand[];
  }
}

// Store the real API instance and command queue
let refRefApi: RefRef | null = null;
const commandQueue: RefRefCommand[] = Array.isArray(
  window.RefRef,
)
  ? window.RefRef
  : [];

// Proxy handler to support both .push and method calls
const target: RefRefClient = Object.assign(RefRefImpl.getInstance(), {
  push(command: RefRefCommand) {
    const [method, ...args] = command;
    const fn = refRefApi?.[method];
    if (typeof fn === "function") {
      return Reflect.apply(fn, refRefApi, args);
    }
    commandQueue.push(command);
  },
});

const handler: ProxyHandler<RefRefClient> = {
  get(_target, prop) {
    switch (prop) {
      case "push":
        return target.push;
      case "isOpen":
        return refRefApi?.isOpen ?? false;
      case "init":
      case "open":
      case "close":
      case "toggle":
      case "setConfig":
      case "getConfig":
        if (refRefApi) return refRefApi[prop].bind(refRefApi);
        return (...args: unknown[]) => {
          commandQueue.push([prop, ...args]);
        };
      default:
        return undefined;
    }
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (refRefApi && (prop === "isOpen" || prop === "getConfig")) {
      return {
        configurable: true,
        enumerable: true,
        value: refRefApi[prop],
      };
    }
    return undefined;
  },
};

window.RefRef = new Proxy(target, handler);

export const initRefRef = () => {
  const refRef = RefRefImpl.getInstance();
  refRefApi = refRef;
  // Process any queued commands
  while (commandQueue.length > 0) {
    const [method, ...args] = commandQueue.shift()!;
    const fn = refRef[method];
    if (typeof fn === "function") {
      Reflect.apply(fn, refRef, args);
    }
  }
  return refRef;
};
