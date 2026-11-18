import { describe, expect, test } from "@rstest/core";
import { hasDisallowedChars, isBlank, isShowable, normalizeText } from "./displayText";

describe("displayText", () => {
  test("normalizes to trimmed NFC", () => {
    expect(normalizeText("  Cafe\u0301 ")).toBe("Caf\u00e9");
  });

  test("joiners are allowed, other control and format characters are not", () => {
    expect(hasDisallowedChars("a\u200cb\u200dc")).toBe(false);
    for (const bad of ["\u200b", "\u202e", "\u2066", "\ufeff", "\u00ad", "\u0000", "\u007f"]) {
      expect(hasDisallowedChars(`a${bad}b`)).toBe(true);
    }
  });

  test("text of nothing but whitespace and joiners is blank", () => {
    expect(isBlank("")).toBe(true);
    expect(isBlank(" \u200d \u200c")).toBe(true);
    expect(isBlank("x")).toBe(false);
    expect(isShowable("\u200d")).toBe(false);
    expect(isShowable("ok")).toBe(true);
  });
});
