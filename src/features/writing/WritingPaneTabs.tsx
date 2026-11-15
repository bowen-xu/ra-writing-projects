import type { WritingPane } from "./useWritingLayout";

interface WritingPaneTabsProps {
  readonly active: WritingPane;
  readonly onSelect: (pane: WritingPane) => void;
}

const PANES: readonly { readonly id: WritingPane; readonly label: string }[] = [
  { id: "explorer", label: "文件" },
  { id: "editor", label: "编辑" },
  { id: "preview", label: "预览" },
];

export function WritingPaneTabs({ active, onSelect }: WritingPaneTabsProps): React.JSX.Element {
  return (
    <div className="writing-narrow-tabs" role="tablist" aria-label="写作面板">
      {PANES.map((pane) => (
        <button aria-selected={pane.id === active} className={pane.id === active ? "active" : ""} key={pane.id} onClick={() => onSelect(pane.id)} role="tab" type="button">
          {pane.label}
        </button>
      ))}
    </div>
  );
}
