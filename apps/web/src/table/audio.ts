import type { CreateAudioEffects } from "../contracts";

export const createAudioEffects: CreateAudioEffects = (createContext) => {
  let context: AudioContext | undefined;
  let disposed = false;

  function tone(
    ctx: AudioContext,
    start: number,
    type: OscillatorType,
    hz: number,
    duration: number,
    peak: number,
    attack: number,
    endHz?: number,
  ) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const end = start + duration;
    osc.type = type;
    osc.frequency.setValueAtTime(hz, start);
    if (endHz !== undefined) osc.frequency.linearRampToValueAtTime(endHz, end);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + attack);
    gain.gain.linearRampToValueAtTime(0, end);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(start);
    osc.stop(end);
  }

  return {
    unlock() {
      if (disposed) return;
      try {
        context ??= createContext();
      } catch {
        disposed = true;
        return;
      }
      void context.resume().catch(() => {});
    },
    play(events) {
      if (disposed || context?.state !== "running") return;
      let start = context.currentTime;
      for (const event of events) {
        if (event.type !== "PLAY") continue;
        tone(context, start, "triangle", 480, 0.045, 0.1, 0.003, 220);
        start += 0.045;
      }
      for (const event of events) {
        if (event.type !== "SETTLEMENT") continue;
        tone(context, start, "square", 440, 0.06, 0.035, 0.004);
        tone(context, start + 0.08, "square", 660, 0.06, 0.035, 0.004);
        start += 0.14;
      }
      for (const event of events) {
        if (event.type !== "MY_TURN") continue;
        tone(context, start, "sine", 660, 0.08, 0.07, 0.004, 880);
        start += 0.08;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void context?.close().catch(() => {});
    },
  };
};
