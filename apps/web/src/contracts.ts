import type { Preview, SeatId, Tile } from "@caxio/shared/contracts/domain";
import type { RoomSettings } from "@caxio/shared/contracts/settings";
import type { Assert, Exact } from "@caxio/shared/contracts/type-check";
import type {
  Command,
  Credential,
  PlayerView,
} from "@caxio/shared/contracts/wire";
export type ConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "RESTORING"
  | "CONNECTED";
/** Read lastGameResult from every accepted lobby view, including a first or resumed snapshot.
 * Only accepted revisions update the model. On game → lobby clear selected and pending PLAY/PASS,
 * preserve mute and the remaining credential. RESUME_DENIED or ROOM_NOT_FOUND on restore clears
 * the stored credential and returns to entry. The UI announces abandonment once from a game → lobby
 * model transition on the same connection; a first/resumed snapshot or duplicate revision is silent. */
export interface ClientModel {
  readonly connection: ConnectionState;
  readonly seatId: SeatId | null;
  readonly view: PlayerView | null;
  readonly revision: number | null;
  readonly selected: readonly Tile[];
  // ERROR sets its code. A rejected server frame sets only errorCode to INVALID_MESSAGE.
  // Every action except setMuted clears it, including toggleTile. Accepted snapshots clear it only on currentTurn change.
  // Controls display errorText(errorCode) while non-null, with no local dismissal state.
  readonly errorCode: string | null;
  readonly muted: boolean;
  readonly pending: Command | null;
  readonly credential: Credential | null;
  readonly timeAnchor: {
    readonly serverNow: number;
    // Assembly injects () => performance.now(); controls use performance.now() for the countdown.
    readonly receivedAt: number;
  } | null;
}
export interface ClientActions {
  // name is the trimmed entry input when isPlayerName accepts it; an empty input omits it (seatLabel display).
  // Each request puts it on CREATE_ROOM/JOIN_ROOM as given. The UI remembers it in localStorage caxio.name.
  createRoom(name?: string, settings?: RoomSettings): void;
  joinRoom(roomCode: string, name?: string): void;
  resume(): void;
  startGame(): void;
  toggleTile(tile: Tile): void;
  play(): void;
  pass(): void;
  setMuted(muted: boolean): void;
  // Optional only so the pre-leave session still compiles; the session that ships the leave button implements it.
  // With a bound seat on an open socket it sends LEAVE_ROOM, then always closes the socket, removes the stored
  // credential and resets the model to entry (DISCONNECTED; no seat, view, revision, time anchor, selection,
  // pending or error), keeping muted. The UI confirms first only while its own seat is active in a running game.
  leaveRoom?(): void;
}
export interface ClientSession extends ClientActions {
  getState(): ClientModel;
  subscribe(
    listener: (state: ClientModel, previous: ClientModel) => void,
  ): () => void;
  dispose(): void;
}
export type ClientEffect =
  | { type: "MY_TURN"; turnId: number }
  | { type: "PLAY"; turnId: number }
  | { type: "SETTLEMENT"; round: number };
export interface ClientDependencies {
  openSocket(events: {
    open(): void;
    message(frame: unknown): void;
    close(): void;
  }): { send(frame: string): void; close(): void };
  storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  monotonicNow(): number;
  // Abandonment emits no effect. Settlement rounds are per game: the next game’s round-1 settlement sounds once.
  // MY_TURN fires once per newly observed own TURN_ACTIVE turnId, never for another seat.
  // Called only for new audible events while unmuted; first/resume snapshots establish a silent baseline.
  effects(events: readonly ClientEffect[]): void;
}
// Construction opens no socket. At startup a room link resumes matching credentials or joins its room. Without a link assembly calls resume() once; without a stored credential it does nothing.
// After an unexpected close with a credential, the session opens a new socket and retries RESUME.
export type CreateClientSession = (deps: ClientDependencies) => ClientSession;
export interface AudioEffects {
  unlock(): void;
  play(events: readonly ClientEffect[]): void;
  dispose(): void;
}
export type CreateAudioEffects = (
  createContext: () => AudioContext,
) => AudioEffects;
export type Rect = Readonly<{ x: number; y: number; w: number; h: number }>;
export type Layout = Readonly<{
  seats: readonly Readonly<{
    seatId: number;
    centerX: number;
    rack: Rect;
    nameplate: Rect;
  }>[];
  hand: readonly Rect[];
  table: readonly Rect[];
  felt: Rect;
}>;
export interface TableProps {
  readonly view: PlayerView;
  readonly selected: readonly Tile[];
  readonly layout: Layout;
  readonly k: number;
  readonly reducedMotion: boolean;
  onReady(): void;
  onFailure(): void;
}
export interface GameControlsProps extends ClientActions {
  readonly model: ClientModel;
  readonly layout: Layout;
  readonly k: number;
  readonly graphicsReady: boolean;
  readonly preview: Preview;
}
export type GameTableComponent<Rendered> = (props: TableProps) => Rendered;
export type GameControlsComponent<Rendered> = (
  props: GameControlsProps,
) => Rendered;

// Independent producer declaration for the standalone worktree. Integration substitutes layout() itself.
type VisualRect = Readonly<{ x: number; y: number; w: number; h: number }>;
type VisualResult = {
  readonly seats: readonly {
    readonly seatId: number;
    readonly centerX: number;
    readonly rack: VisualRect;
    readonly nameplate: VisualRect;
  }[];
  readonly hand: readonly VisualRect[];
  readonly table: readonly VisualRect[];
  readonly felt: VisualRect;
};

export type LayoutContractCheck = Assert<
  VisualResult extends TableProps["layout"] & GameControlsProps["layout"]
    ? true
    : false
>;

interface StoreSpec extends ClientActions {
  getState(): ClientModel;
  subscribe(
    listener: (state: ClientModel, previous: ClientModel) => void,
  ): () => void;
  dispose(): void;
}
interface ControlsSpec extends ClientActions {
  readonly model: ClientModel;
  readonly layout: Layout;
  readonly k: number;
  readonly graphicsReady: boolean;
  readonly preview: Preview;
}
export type ControlsContractCheck = Assert<
  Exact<GameControlsProps, ControlsSpec>
>;
export type TableContractCheck = Assert<
  Exact<
    TableProps,
    {
      readonly view: PlayerView;
      readonly selected: readonly Tile[];
      readonly layout: Layout;
      readonly k: number;
      readonly reducedMotion: boolean;
      onReady(): void;
      onFailure(): void;
    }
  >
>;
export type ClientContractCheck = Assert<
  Exact<
    [
      ClientSession,
      ClientModel,
      ClientActions,
      ClientDependencies,
      ClientEffect,
      CreateClientSession,
      CreateAudioEffects,
      AudioEffects,
    ],
    [
      StoreSpec,
      {
        readonly connection: ConnectionState;
        readonly seatId: SeatId | null;
        readonly view: PlayerView | null;
        readonly revision: number | null;
        readonly selected: readonly Tile[];
        readonly errorCode: string | null;
        readonly muted: boolean;
        readonly pending: Command | null;
        readonly credential: Credential | null;
        readonly timeAnchor: {
          readonly serverNow: number;
          readonly receivedAt: number;
        } | null;
      },
      {
        createRoom(name?: string, settings?: RoomSettings): void;
        joinRoom(roomCode: string, name?: string): void;
        resume(): void;
        startGame(): void;
        toggleTile(tile: Tile): void;
        play(): void;
        pass(): void;
        setMuted(muted: boolean): void;
        leaveRoom?(): void;
      },
      {
        openSocket(events: {
          open(): void;
          message(frame: unknown): void;
          close(): void;
        }): { send(frame: string): void; close(): void };
        storage: {
          getItem(key: string): string | null;
          setItem(key: string, value: string): void;
          removeItem(key: string): void;
        };
        monotonicNow(): number;
        effects(events: readonly ClientEffect[]): void;
      },
      (
        | { type: "MY_TURN"; turnId: number }
        | { type: "PLAY"; turnId: number }
        | { type: "SETTLEMENT"; round: number }
      ),
      (deps: ClientDependencies) => ClientSession,
      (createContext: () => AudioContext) => AudioEffects,
      {
        unlock(): void;
        play(events: readonly ClientEffect[]): void;
        dispose(): void;
      },
    ]
  >
>;
