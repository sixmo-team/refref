// Export plugins
export { default as coredbPlugin } from "./plugins/coredb.js";

// Export refcode utilities
export {
  generateGlobalCode,
  validateVanityCode,
  normalizeCode,
  isGlobalCodeFormat,
  isRefcodeFormat,
} from "./refcode.js";

export {
  safeError,
  safeLogSerializers,
  type ErrorDiagnostic,
} from "./logging.js";
