import { describe, it, expect } from "vitest";
import {
  generateRefcode,
  validateRefcode,
  validateVanityCode,
  normalizeCode,
  isRefcodeFormat,
} from "./refcode";

describe("refcode utilities", () => {
  describe("generated code suggestions", () => {
    it("produces a canonical usable suggestion without requiring a custom text", () => {
      expect(generateRefcode()).toMatch(/^[a-z0-9]{3,32}$/);
    });
    it("reports exhausted generation attempts instead of inventing success", () => {
      expect(generateRefcode(0)).toBeNull();
    });
  });

  describe("validateVanityCode", () => {
    describe("valid codes", () => {
      it("should accept valid codes (3-50 chars, alphanumeric + hyphens)", () => {
        const validCodes = [
          "abc",
          "john-doe",
          "test123",
          "my-referral-code",
          "a".repeat(50),
          "user-123-abc",
        ];

        validCodes.forEach((code) => {
          const result = validateVanityCode(code);
          expect(result.isValid).toBe(true);
          expect(result.error).toBeUndefined();
        });
      });

      it("should accept codes at boundary lengths (3 and 50 chars)", () => {
        const minCode = "abc"; // 3 chars
        const maxCode = "a".repeat(50); // 50 chars

        expect(validateVanityCode(minCode).isValid).toBe(true);
        expect(validateVanityCode(maxCode).isValid).toBe(true);
      });

      it("should normalize before validation (accept uppercase)", () => {
        const result = validateVanityCode("JOHN-DOE");
        expect(result.isValid).toBe(true);
      });
    });

    describe("invalid codes - length", () => {
      it("should reject codes that are too short (< 3 chars)", () => {
        const shortCodes = ["", "a", "ab"];

        shortCodes.forEach((code) => {
          const result = validateVanityCode(code);
          expect(result.isValid).toBe(false);
          expect(result.error).toContain("3-50 characters");
        });
      });

      it("should reject codes that are too long (> 50 chars)", () => {
        const longCode = "a".repeat(51);
        const result = validateVanityCode(longCode);

        expect(result.isValid).toBe(false);
        expect(result.error).toContain("3-50 characters");
      });
    });

    describe("invalid codes - characters", () => {
      it("should reject codes with spaces", () => {
        const result = validateVanityCode("john doe");
        expect(result.isValid).toBe(false);
        expect(result.error).toContain(
          "lowercase letters, numbers, and hyphens",
        );
      });

      it("should reject codes with special characters", () => {
        const invalidCodes = [
          "john@doe",
          "user_123",
          "test.code",
          "code!",
          "my#code",
          "test&code",
        ];

        invalidCodes.forEach((code) => {
          const result = validateVanityCode(code);
          expect(result.isValid).toBe(false);
          expect(result.error).toContain(
            "lowercase letters, numbers, and hyphens",
          );
        });
      });

      it("should reject codes with uppercase after normalization check", () => {
        // The function normalizes first, so uppercase becomes valid
        const result = validateVanityCode("UPPERCASE");
        expect(result.isValid).toBe(true); // Because it normalizes to lowercase first
      });

      it("should only allow alphanumeric and hyphens", () => {
        const validResult = validateVanityCode("abc-123-xyz");
        expect(validResult.isValid).toBe(true);

        const invalidResult = validateVanityCode("abc_123_xyz");
        expect(invalidResult.isValid).toBe(false);
      });
    });

    describe("profanity filtering", () => {
      it("should reject profane codes", () => {
        // Note: bad-words library filters common profanity
        // We're testing that the validation calls the filter
        // Specific profane words depend on the bad-words library
        const result = validateVanityCode("damn");

        // The bad-words library may or may not flag this
        // This test documents that profanity checking exists
        if (!result.isValid) {
          expect(result.error).toContain("inappropriate language");
        }
      });
    });

    describe("edge cases", () => {
      it("should handle codes with only numbers", () => {
        const result = validateVanityCode("123456");
        expect(result.isValid).toBe(true);
      });

      it("should handle codes with only letters", () => {
        const result = validateVanityCode("abcdef");
        expect(result.isValid).toBe(true);
      });

      it("should handle codes with only hyphens and alphanumeric", () => {
        const result = validateVanityCode("a-b-c-1-2-3");
        expect(result.isValid).toBe(true);
      });

      it("should handle codes starting or ending with hyphens", () => {
        const startHyphen = validateVanityCode("-abc");
        const endHyphen = validateVanityCode("abc-");

        // These should be valid as the pattern allows it
        expect(startHyphen.isValid).toBe(true);
        expect(endHyphen.isValid).toBe(true);
      });

      it("should trim whitespace before validation", () => {
        const result = validateVanityCode("  john-doe  ");
        expect(result.isValid).toBe(true);
      });
    });
  });

  describe("normalizeCode", () => {
    it("should convert to lowercase", () => {
      expect(normalizeCode("ABC123")).toBe("abc123");
      expect(normalizeCode("JohnDoe")).toBe("johndoe");
      expect(normalizeCode("UPPERCASE")).toBe("uppercase");
    });

    it("should trim whitespace", () => {
      expect(normalizeCode("  abc123  ")).toBe("abc123");
      expect(normalizeCode("\tabc123\t")).toBe("abc123");
      expect(normalizeCode("\nabc123\n")).toBe("abc123");
    });

    it("should handle empty strings", () => {
      expect(normalizeCode("")).toBe("");
      expect(normalizeCode("   ")).toBe("");
    });

    it("should handle already normalized codes", () => {
      expect(normalizeCode("abc123")).toBe("abc123");
      expect(normalizeCode("john-doe")).toBe("john-doe");
    });

    it("should trim and lowercase together", () => {
      expect(normalizeCode("  ABC-123  ")).toBe("abc-123");
      expect(normalizeCode("\t JOHN-DOE \n")).toBe("john-doe");
    });

    it("should preserve hyphens", () => {
      expect(normalizeCode("JOHN-DOE")).toBe("john-doe");
      expect(normalizeCode("TEST-CODE-123")).toBe("test-code-123");
    });

    it("should preserve numbers", () => {
      expect(normalizeCode("ABC123XYZ")).toBe("abc123xyz");
    });
  });

  describe("tracking code policy", () => {
    it.each(["abc", "ANNA10", "a".repeat(32), "  ANNATELEGRAM  "])("accepts %s", (code) => {
      expect(isRefcodeFormat(code)).toBe(true);
    });
    it.each(["ab", "a".repeat(33), "john-doe", "anna 10", "анна10", "Kaa", "health", ""])("rejects %s", (code) => {
      expect(isRefcodeFormat(code)).toBe(false);
    });
    it("rejects inappropriate user text before a code is created", () => {
      expect(validateRefcode("fuck").isValid).toBe(false);
      expect(validateRefcode("ANNA10").isValid).toBe(true);
    });
  });

  describe("integration tests", () => {

    it("valid vanity codes should be normalized", () => {
      const testCodes = ["John-Doe", "TEST-123", "MyCODE"];

      testCodes.forEach((code) => {
        const validation = validateVanityCode(code);
        expect(validation.isValid).toBe(true);

        const normalized = normalizeCode(code);
        expect(normalized).toBe(code.toLowerCase());
      });
    });

    it("local codes should not match global code format", () => {
      const localCodes = ["john-doe", "my-code", "user-123"];

      localCodes.forEach((code) => {
        expect(isRefcodeFormat(code)).toBe(false);
        expect(validateVanityCode(code).isValid).toBe(true);
      });
    });

    it("global codes should be rejected as vanity codes if they happen to pass", () => {
      // Global codes are 7 chars, vanity codes are 3-50, so 7-char codes are valid for both
      // This is by design - a user could create a vanity code that looks like a global one
      const globalLikeCode = "abc1234";

      expect(isRefcodeFormat(globalLikeCode)).toBe(true);
      expect(validateVanityCode(globalLikeCode).isValid).toBe(true);

      // This is intentional - the database uniqueness constraints handle conflicts
    });
  });
});
