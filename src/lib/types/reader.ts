import type { Title } from './catalog';
import type {
  PanelRegionDto,
  ProseBlockData,
  ReaderAccess,
  ReaderDocument
} from './publication';

export interface PageBoxInput {
  vw: number;
  vh: number;
  narrow: boolean;
  fontSize: number;
  chrome?: number;
}

export interface PageBox {
  pw: number;
  ph: number;
  pad: number;
  fs: number;
}

export interface ReadingAnchor {
  chapter: number;
  at: number;
}

export interface PanelCell {
  c: number;
  r: number;
  cap: string;
}

interface ReaderPageBase {
  chapter: number;
  at: number;
  folio: string;
}

export interface TextReaderPage extends ReaderPageBase {
  type: 'text';
  heading: string | null;
  paras: string[];
  blocks?: readonly RenderedProseBlock[];
  layout?: never;
  label?: never;
}

export interface ComicReaderPage extends ReaderPageBase {
  type: 'comic';
  sourcePageId: string;
  layout: PanelCell[];
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  panels?: readonly PanelRegionDto[];
  heading?: never;
  paras?: never;
  label?: never;
}

export interface ScanReaderPage extends ReaderPageBase {
  type: 'scan';
  label: string;
  heading?: never;
  paras?: never;
  layout?: never;
}

export type ReaderPage = TextReaderPage | ComicReaderPage | ScanReaderPage;
export type PaperId = 'white' | 'sepia' | 'dim';
export type TypefaceId = 'serif' | 'sans' | 'georgia';

export interface ReaderPreferences {
  fontSize: number;
  typeface: TypefaceId;
  paper: PaperId;
}

export interface RenderedProseBlock {
  sourceBlockId: string;
  sourceStartOffset: number;
  sourceEndOffset: number;
  content: ProseBlockData;
  imageUrl?: string;
}

export type ReaderPhase =
  | 'closed'
  | 'opening'
  | 'openingEnd'
  | 'reading'
  | 'closing'
  | 'closingEnd';
export type TurnDirection = -1 | 1;

export interface TurnProgress {
  dir: TurnDirection;
  t: number;
}

export interface SheetView {
  k: number;
  angle: number;
  curl: number;
  active: boolean;
  z: number;
  showFront: boolean;
  showBack: boolean;
  front: ReaderPage | null;
  back: ReaderPage | null;
}

export type EasingFunction = (position: number) => number;

export interface ReaderProps {
  document: ReaderDocument;
  access: ReaderAccess;
  onclose?: () => void;
  onbuy?: () => void;
}

// Retained for prototype-only callers that still use the legacy paginator.
export interface PrototypeReaderProps {
  title: Title;
  sample?: boolean;
  onclose?: () => void;
  onbuy?: () => void;
}
