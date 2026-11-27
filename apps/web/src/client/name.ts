import { isPlayerName } from "@caxio/shared/contracts/wire";

/** Empty entry input omits the optional name. Invalid input must not open a socket. */
export function entryName(input = ""): string | undefined | false {
  const name = input.trim().normalize("NFC");
  return !name ? undefined : isPlayerName(name) ? name : false;
}
