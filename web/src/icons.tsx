import type { ReactElement } from "react";
import type { Icon as PhosphorIcon, IconWeight } from "@phosphor-icons/react";
import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Stop } from "@phosphor-icons/react/dist/csr/Stop";
import { BellSimple } from "@phosphor-icons/react/dist/csr/BellSimple";
import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { PaperPlaneTilt } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CaretLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUp } from "@phosphor-icons/react/dist/csr/CaretUp";
import { ArrowDown } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { Microphone } from "@phosphor-icons/react/dist/csr/Microphone";
import { LockSimple } from "@phosphor-icons/react/dist/csr/LockSimple";
import { MicrophoneSlash } from "@phosphor-icons/react/dist/csr/MicrophoneSlash";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { Monitor } from "@phosphor-icons/react/dist/csr/Monitor";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { GitBranch } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitPullRequest } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { Image } from "@phosphor-icons/react/dist/csr/Image";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Brain } from "@phosphor-icons/react/dist/csr/Brain";
import { ArrowBendUpLeft } from "@phosphor-icons/react/dist/csr/ArrowBendUpLeft";
import { SortDescending } from "@phosphor-icons/react/dist/csr/SortDescending";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { Repeat } from "@phosphor-icons/react/dist/csr/Repeat";
import { User } from "@phosphor-icons/react/dist/csr/User";
import { WifiSlash } from "@phosphor-icons/react/dist/csr/WifiSlash";
import { Users } from "@phosphor-icons/react/dist/csr/Users";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { Key } from "@phosphor-icons/react/dist/csr/Key";
import { ArrowsInLineVertical } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { ArrowsOutLineVertical } from "@phosphor-icons/react/dist/csr/ArrowsOutLineVertical";
import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { Gauge } from "@phosphor-icons/react/dist/csr/Gauge";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { Link } from "@phosphor-icons/react/dist/csr/Link";
import { ArrowUUpLeft } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";
import { Plugs } from "@phosphor-icons/react/dist/csr/Plugs";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { PushPin } from "@phosphor-icons/react/dist/csr/PushPin";
import { BookmarkSimple } from "@phosphor-icons/react/dist/csr/BookmarkSimple";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { Heartbeat } from "@phosphor-icons/react/dist/csr/Heartbeat";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Pause } from "@phosphor-icons/react/dist/csr/Pause";

export type IconProps = { size?: number; className?: string; weight?: IconWeight };
export type IconComponent = (props: IconProps) => ReactElement;

/** Keep the app's small, decorative icons consistent and preserve button labels. */
const icon = (Glyph: PhosphorIcon): IconComponent =>
  ({ size = 16, className, weight = "regular" }) => (
    <Glyph size={size} className={className} weight={weight} aria-hidden="true" focusable="false" />
  );

/** The Sessions mark is Agentbox's own; the rest use Phosphor. */
export const Icon = {
  sessions: ({ size = 16, className }: IconProps) => (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 18h7M20 5l-7 7 7 7" />
    </svg>
  ),
  settings: icon(GearSix),
  cards: icon(Stack),
  plus: icon(Plus),
  play: icon(Play),
  stop: icon(Stop),
  bell: icon(BellSimple),
  refresh: icon(ArrowsClockwise),
  trash: icon(Trash),
  send: icon(PaperPlaneTilt),
  paperclip: icon(Paperclip),
  check: icon(Check),
  x: icon(X),
  chevronRight: icon(CaretRight),
  chevronLeft: icon(CaretLeft),
  chevronDown: icon(CaretDown),
  chevronUp: icon(CaretUp),
  arrowDown: icon(ArrowDown),
  arrowUp: icon(ArrowUp),
  mic: icon(Microphone),
  lock: icon(LockSimple),
  micOff: icon(MicrophoneSlash),
  external: icon(ArrowSquareOut),
  sun: icon(Sun),
  moon: icon(Moon),
  monitor: icon(Monitor),
  alert: icon(Warning),
  branch: icon(GitBranch),
  prs: icon(GitPullRequest),
  folder: icon(FolderSimple),
  image: icon(Image),
  edit: icon(PencilSimple),
  terminal: icon(TerminalWindow),
  search: icon(MagnifyingGlass),
  brain: icon(Brain),
  move: icon(ArrowBendUpLeft),
  sort: icon(SortDescending),
  clock: icon(Clock),
  repeat: icon(Repeat),
  user: icon(User),
  wifiOff: icon(WifiSlash),
  users: icon(Users),
  copy: icon(Copy),
  key: icon(Key),
  fold: icon(ArrowsInLineVertical),
  unfold: icon(ArrowsOutLineVertical),
  bolt: icon(Lightning),
  gauge: icon(Gauge),
  chart: icon(ChartBar),
  link: icon(Link),
  undo: icon(ArrowUUpLeft),
  plugs: icon(Plugs),
  plugsOn: icon(PlugsConnected),
  pin: icon(PushPin),
  bookmark: icon(BookmarkSimple),
  wrench: icon(Wrench),
  cloud: icon(Cloud),
  heartbeat: icon(Heartbeat),
  sparkle: icon(Sparkle),
  pause: icon(Pause),
};
