import { expect, test } from "@rstest/core";
import { formatTimestamp, shortId } from "./format";

test("formatTimestamp renders Unix seconds as a local date and time", () => {
  const text = formatTimestamp(1_700_000_000, "en-US");
  expect(text).toContain("2023");
  expect(text).toMatch(/\d{1,2}:\d{2}/);
});

test("formatTimestamp works without an explicit locale", () => {
  expect(formatTimestamp(0)).not.toBe("");
});

test("shortId keeps the first eight characters", () => {
  expect(shortId("12345678-aaaa-bbbb-cccc-dddddddddddd")).toBe("12345678");
});
