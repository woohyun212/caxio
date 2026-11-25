import { expect, test } from "bun:test";
import { SHARED_NAME } from "@caxio/shared";

test("shared workspace export resolves", () => {
  expect(SHARED_NAME).toBe("@caxio/shared");
});
