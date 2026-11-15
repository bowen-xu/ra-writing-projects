import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import type { LatexOutlineEntry } from "@research-assistant/writing";

interface OutlinePanelProps {
  readonly entries: readonly LatexOutlineEntry[];
  readonly onSelect: (entry: LatexOutlineEntry) => void;
}

export function OutlinePanel({ entries, onSelect }: OutlinePanelProps): React.JSX.Element {
  return (
    <div className="writing-outline" aria-label="当前文件大纲">
      {entries.length === 0
        ? <p>当前文件没有 section 标题</p>
        : entries.map((entry) => (
            <ControlHint content={`${entry.command} · 第 ${entry.line} 行`} key={`${entry.offset}:${entry.title}`}><button aria-label={`${entry.command} · 第 ${entry.line} 行`}
              onClick={() => onSelect(entry)}
              style={{ paddingInlineStart: `${10 + Math.max(0, entry.depth - 2) * 10}px` }}
              type="button"
            >
              <span>{entry.command}</span>
              <strong>{entry.title}</strong>
            </button></ControlHint>
          ))}
    </div>
  );
}
