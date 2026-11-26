import * as shared from "@caxio/shared/contracts/fixtures";
import { DEFAULT_TURN_LIMIT_SECONDS } from "@caxio/shared/contracts/settings";

// Older wire examples omit the optional turn limit. The server always publishes it.
function withTurnLimit<T>(fixture: T): T {
  const copy = structuredClone(fixture);
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (
      "type" in value &&
      value.type === "SNAPSHOT" &&
      "view" in value &&
      value.view &&
      typeof value.view === "object"
    ) {
      Object.assign(value.view, {
        turnLimitSeconds: DEFAULT_TURN_LIMIT_SECONDS,
      });
      return;
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(copy);
  return copy;
}

export const abandonmentLobbyExamples = withTurnLimit(
  shared.abandonmentLobbyExamples,
);
export const abandonmentLobbyResume = withTurnLimit(
  shared.abandonmentLobbyResume,
);
export const abandonmentRestart = withTurnLimit(shared.abandonmentRestart);
export const deadlines = withTurnLimit(shared.deadlines);
export const dealExamples = withTurnLimit(shared.dealExamples);
export const lastPlaySequence = withTurnLimit(shared.lastPlaySequence);
export const leaveExamples = withTurnLimit(shared.leaveExamples);
export const lostResume = withTurnLimit(shared.lostResume);
export const newRoomSequence = withTurnLimit(shared.newRoomSequence);
export const nonHostAbandonmentLobby = withTurnLimit(
  shared.nonHostAbandonmentLobby,
);
export const phaseExamples = withTurnLimit(shared.phaseExamples);
export const seatReuse = withTurnLimit(shared.seatReuse);
export const seatedRejections = withTurnLimit(shared.seatedRejections);
export const spectatorExamples = withTurnLimit(shared.spectatorExamples);
