import { expect, test } from "bun:test";
import { handOrder } from "../../apps/web/src/visual/layout";
import { rules } from "../../packages/shared/src/index";
import { generalCreate } from "./game";
import { need, singleAction } from "./judges";

test("three seats reach the configured last round across seeded games", () => {
  let worstLoss = 0,
    worstFirstTwo = 0,
    rounds = 0;
  const games = 10000;
  for (let seed = 1; seed <= games; seed++) {
    let random = seed;
    const rng = () => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return random / 2 ** 32;
    };
    let g = rules.startRound([0, 1, 2], rng, generalCreate.maxRounds);
    while (g.phase !== "GAME_OVER") {
      if (g.phase !== "TURN_ACTIVE") {
        if (g.phase === "ROUND_START") {
          expect(g.activePlayers.length).toBe(3);
          rounds++;
        }
        g = rules.advance(g, rng);
        continue;
      }
      const seat = need(g.currentTurn, "missing turn"),
        max = need(g.maxNumber, "missing deck");
      const hand = need(g.players[seat], "missing player").hand;
      const r = rules.applyTurn(
        g,
        seat,
        singleAction(handOrder(hand, max), g.tableHand, max),
      );
      if (!r.ok) throw new Error(`seed ${seed}: ${r.code}`);
      if (r.state.phase === "ROUND_SETTLEMENT")
        for (const id of g.activePlayers) {
          const balance = need(
            r.state.players[id],
            "missing settled player",
          ).chips;
          worstLoss = Math.max(
            worstLoss,
            need(g.players[id], "missing payer").chips - balance,
          );
          if (g.round <= 2)
            worstFirstTwo = Math.max(worstFirstTwo, 64 - balance);
        }
      g = r.state;
    }
    expect(g.round, `seed ${seed}`).toBe(generalCreate.maxRounds);
  }
  console.info(
    `${games} games, ${rounds} rounds, worst single-round chip loss ${worstLoss}, worst deficit after first two rounds ${worstFirstTwo}`,
  );
});
