import { expect, test } from "bun:test";
import { ENGINE_NAME } from "./index";

test("toolchain smoke: engine module loads", () => {
  expect(ENGINE_NAME).toBe("@caxio/engine");
});
