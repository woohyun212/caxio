import type { Preview, SeatId, Tile } from "@caxio/shared/contracts/domain";
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
export interface ClientModel {
  readonly connection: ConnectionState;
  readonly seatId: SeatId | null;
  readonly view: PlayerView | null;
  readonly revision: number | null;
  readonly selected: readonly Tile[];
  // Last ERROR.code as received, including unknown codes. The UI maps it with errorText.
  readonly errorCode: string | null;
  readonly muted: boolean;
  readonly pending: Command | null;
  readonly credential: Credential | null;
  readonly timeAnchor: {
    readonly serverNow: number;
    // Client monotonic milliseconds from monotonicNow (performance.now in the browser).
    readonly receivedAt: number;
  } | null;
}
export interface ClientActions {
  createRoom(): void;
  joinRoom(roomCode: string): void;
  resume(): void;
  startGame(): void;
  toggleTile(tile: Tile): void;
  play(): void;
  pass(): void;
  setMuted(muted: boolean): void;
}
export interface ClientSession extends ClientActions {
  getState(): ClientModel;
  subscribe(
    listener: (state: ClientModel, previous: ClientModel) => void,
  ): () => void;
  dispose(): void;
}
export type ClientEffect =
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
  // Called only for new audible events while unmuted; first/resume snapshots establish a silent baseline.
  effects(events: readonly ClientEffect[]): void;
}
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
        createRoom(): void;
        joinRoom(roomCode: string): void;
        resume(): void;
        startGame(): void;
        toggleTile(tile: Tile): void;
        play(): void;
        pass(): void;
        setMuted(muted: boolean): void;
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
      { type: "PLAY"; turnId: number } | { type: "SETTLEMENT"; round: number },
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
