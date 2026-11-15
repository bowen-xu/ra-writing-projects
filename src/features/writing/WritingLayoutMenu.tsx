import { Check, Columns2, FileText, Focus, Pencil, ChevronDown } from "lucide-react";
import { WritingMenu, WritingMenuItem } from "./WritingMenu";
import type { WritingViewMode } from "./useWritingLayout";
export const isWritingMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform);
interface Props { readonly mode: WritingViewMode; readonly focused: boolean; readonly onMode: (mode: WritingViewMode) => void; readonly onFocus: () => void; }
export function WritingLayoutMenu({ mode, focused, onMode, onFocus }: Props): React.JSX.Element {
  const items = [
    { mode: "split" as const, label: "源码与 PDF", icon: Columns2, shortcut: "⌃ ⌘ ↓" },
    { mode: "editor" as const, label: "仅源码", icon: Pencil, shortcut: "⌃ ⌘ ←" },
    { mode: "preview" as const, label: "仅 PDF", icon: FileText, shortcut: "⌃ ⌘ →" },
  ];
  return <WritingMenu label="布局" menuLabel="布局选项" className="writing-layout-menu" triggerClassName="writing-layout-trigger" contentClassName="writing-layout-options" trigger={<><Columns2 size={18} />布局<ChevronDown size={13} /></>}>
    <span className="writing-layout-heading">布局选项</span>
    {items.map((item) => <WritingMenuItem role="menuitemradio" aria-checked={mode === item.mode} key={item.mode} onClick={() => onMode(item.mode)}>{mode === item.mode ? <Check size={18} /> : <item.icon size={18} />}<span>{item.label}</span>{isWritingMac() && <kbd>{item.shortcut}</kbd>}</WritingMenuItem>)}
    <hr />
    <WritingMenuItem role="menuitemcheckbox" aria-checked={focused} onClick={onFocus}>{focused ? <Check size={18} /> : <Focus size={18} />}<span>专注模式</span><kbd>{isWritingMac() ? "⌘ ⇧ M" : "Ctrl Shift M"}</kbd></WritingMenuItem>
  </WritingMenu>;
}
