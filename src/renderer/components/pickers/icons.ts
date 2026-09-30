// Command entries name their icon as a lucide name ("columns-2"). Importing every lucide icon would
// bloat the bundle, so this is a short list of the ones commands actually use, plus a fallback.
import type { Component } from 'svelte';
import Ban from '@lucide/svelte/icons/ban';
import Calendar from '@lucide/svelte/icons/calendar';
import Clock from '@lucide/svelte/icons/clock';
import FileType from '@lucide/svelte/icons/file-type';
import HardDrive from '@lucide/svelte/icons/hard-drive';
import Ratio from '@lucide/svelte/icons/ratio';
import Ruler from '@lucide/svelte/icons/ruler';
import Shapes from '@lucide/svelte/icons/shapes';
import StickyNote from '@lucide/svelte/icons/sticky-note';
import Clipboard from '@lucide/svelte/icons/clipboard-paste';
import Columns2 from '@lucide/svelte/icons/columns-2';
import Command from '@lucide/svelte/icons/command';
import Copy from '@lucide/svelte/icons/copy';
import Download from '@lucide/svelte/icons/download';
import Files from '@lucide/svelte/icons/files';
import Folder from '@lucide/svelte/icons/folder';
import FolderInput from '@lucide/svelte/icons/folder-input';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import FolderPlus from '@lucide/svelte/icons/folder-plus';
import Funnel from '@lucide/svelte/icons/funnel';
import History from '@lucide/svelte/icons/history';
import Image from '@lucide/svelte/icons/image';
import Inbox from '@lucide/svelte/icons/inbox';
import Keyboard from '@lucide/svelte/icons/keyboard';
import Upload from '@lucide/svelte/icons/upload';
import Bookmark from '@lucide/svelte/icons/bookmark';
import Pause from '@lucide/svelte/icons/pause';
import CopyPlus from '@lucide/svelte/icons/copy-plus';
import Contrast from '@lucide/svelte/icons/contrast';
import Library from '@lucide/svelte/icons/library';
import Link from '@lucide/svelte/icons/link';
import ListFilter from '@lucide/svelte/icons/list-filter';
import PanelLeft from '@lucide/svelte/icons/panel-left';
import PanelRight from '@lucide/svelte/icons/panel-right';
import Pencil from '@lucide/svelte/icons/pencil';
import Pipette from '@lucide/svelte/icons/pipette';
import Play from '@lucide/svelte/icons/play';
import Plus from '@lucide/svelte/icons/plus';
import Redo2 from '@lucide/svelte/icons/redo-2';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import Search from '@lucide/svelte/icons/search';
import Settings from '@lucide/svelte/icons/settings';
import Shuffle from '@lucide/svelte/icons/shuffle';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Star from '@lucide/svelte/icons/star';
import Tag from '@lucide/svelte/icons/tag';
import Tags from '@lucide/svelte/icons/tags';
import Trash2 from '@lucide/svelte/icons/trash-2';
import Undo2 from '@lucide/svelte/icons/undo-2';
import X from '@lucide/svelte/icons/x';
import ZoomIn from '@lucide/svelte/icons/zoom-in';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ICONS: Record<string, Component<any>> = {
  ban: Ban,
  calendar: Calendar,
  clock: Clock,
  'file-type': FileType,
  'hard-drive': HardDrive,
  ratio: Ratio,
  ruler: Ruler,
  shapes: Shapes,
  'sticky-note': StickyNote,
  'clipboard-paste': Clipboard,
  'columns-2': Columns2,
  command: Command,
  copy: Copy,
  download: Download,
  files: Files,
  folder: Folder,
  'folder-input': FolderInput,
  'folder-open': FolderOpen,
  'folder-plus': FolderPlus,
  funnel: Funnel,
  history: History,
  image: Image,
  inbox: Inbox,
  keyboard: Keyboard,
  upload: Upload,
  bookmark: Bookmark,
  pause: Pause,
  'copy-plus': CopyPlus,
  contrast: Contrast,
  library: Library,
  link: Link,
  'list-filter': ListFilter,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  pencil: Pencil,
  pipette: Pipette,
  play: Play,
  plus: Plus,
  'redo-2': Redo2,
  'refresh-cw': RefreshCw,
  search: Search,
  settings: Settings,
  shuffle: Shuffle,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  tags: Tags,
  'trash-2': Trash2,
  'undo-2': Undo2,
  x: X,
  'zoom-in': ZoomIn,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function iconFor(
  name: string | undefined,
  fallback: Component<any> = Command,
): Component<any> {
  return (name && ICONS[name]) || fallback;
}
