import { expect, test } from "bun:test";
import { createAudioEffects } from "./audio";

test("gesture, batch scheduling, drops and repeated IDs", async () => {
  const starts: number[] = [],
    stops: number[] = [],
    types: string[] = [],
    hz: number[][] = [],
    gains: number[][] = [];
  let created = 0,
    resumes = 0,
    closed = 0;
  const ramps: number[][] = [];
  function param(log: number[][]) {
    return {
      setValueAtTime: (v: number, t: number) => log.push([v, t]),
      linearRampToValueAtTime: (v: number, t: number) => {
        ramps.push([v, t]);
        log.push([v, t]);
      },
    };
  }
  const ctx = {
    currentTime: 0,
    state: "suspended",
    resume: async () => {
      resumes++;
    },
    close: async () => {
      closed++;
    },
    destination: {},
    createOscillator() {
      return {
        type: "",
        frequency: param(hz),
        connect() {},
        start(t: number) {
          starts.push(t);
          types.push(this.type);
        },
        stop(t: number) {
          stops.push(t);
        },
      };
    },
    createGain: () => ({ gain: param(gains), connect() {} }),
  };
  const sound = createAudioEffects(() => {
    created++;
    return ctx as unknown as AudioContext;
  });
  const batch = [
    { type: "MY_TURN", turnId: 2 },
    { type: "SETTLEMENT", round: 1 },
    { type: "PLAY", turnId: 1 },
  ] as const;
  sound.play(batch);
  sound.unlock();
  sound.unlock();
  sound.play(batch);
  expect(starts).toEqual([]);
  ctx.state = "running";
  sound.play(batch);
  expect(created).toBe(1);
  expect(resumes).toBeGreaterThan(0);
  expect(types).toEqual(["triangle", "square", "square", "sine"]);
  expect(starts).toEqual([0, 0.045, 0.125, 0.045 + 0.14]);
  expect(stops).toEqual([0.045, 0.045 + 0.06, 0.185, 0.045 + 0.14 + 0.08]);
  expect(hz).toEqual([
    [480, 0],
    [220, 0.045],
    [440, 0.045],
    [660, 0.125],
    [660, 0.045 + 0.14],
    [880, 0.045 + 0.14 + 0.08],
  ]);
  expect(gains).toEqual([
    [0, 0],
    [0.1, 0.003],
    [0, 0.045],
    [0, 0.045],
    [0.035, 0.045 + 0.004],
    [0, 0.045 + 0.06],
    [0, 0.125],
    [0.035, 0.125 + 0.004],
    [0, 0.185],
    [0, 0.045 + 0.14],
    [0.07, 0.045 + 0.14 + 0.004],
    [0, 0.045 + 0.14 + 0.08],
  ]);
  expect(ramps).toEqual([
    [220, 0.045],
    [0.1, 0.003],
    [0, 0.045],
    [0.035, 0.045 + 0.004],
    [0, 0.045 + 0.06],
    [0.035, 0.125 + 0.004],
    [0, 0.185],
    [880, 0.045 + 0.14 + 0.08],
    [0.07, 0.045 + 0.14 + 0.004],
    [0, 0.045 + 0.14 + 0.08],
  ]);
  sound.play([batch[2]]);
  expect(starts).toHaveLength(5);
  sound.dispose();
  sound.play(batch);
  sound.dispose();
  expect(closed).toBe(1);
  expect(starts).toHaveLength(5);
});
test("an unavailable context is attempted once", () => {
  let calls = 0;
  const effects = createAudioEffects(() => {
    calls++;
    throw Error("unavailable");
  });
  effects.unlock();
  effects.unlock();
  effects.play([{ type: "PLAY", turnId: 1 }]);
  expect(calls).toBe(1);
});
test("standalone browser audio bundle includes no graphics imports", async () => {
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/audio.ts`],
    target: "browser",
    metafile: true,
  });
  expect(result.success).toBe(true);
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  expect(inputs.some((p) => p.endsWith("audio.ts"))).toBe(true);
  expect(inputs.some((p) => p.includes("three") || p.includes("fiber"))).toBe(
    false,
  );
});
