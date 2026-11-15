import { Dialog } from "@research-assistant/workbench-sdk/overlay";

import { useMemo, useState } from "react";

export interface WritingCommand {
  readonly description: string;
  readonly disabled?: boolean;
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
  readonly shortcut?: string;
}

interface WritingCommandPaletteProps {
  readonly commands: readonly WritingCommand[];
  readonly returnFocus?: HTMLElement | null;
  readonly onClose: () => void;
}

export function WritingCommandPalette(props: WritingCommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => filterWritingCommands(props.commands, query), [props.commands, query]);
  const boundedIndex = Math.min(activeIndex, Math.max(filtered.length - 1, 0));


  function run(command: WritingCommand | undefined): void {
    if (command === undefined || command.disabled === true) return;
    props.onClose();
    command.run();
  }

  return (
      <Dialog open finalFocus={props.returnFocus ?? null} onClose={props.onClose} portal backdrop={<div className="writing-command-overlay" />}
        aria-label="LaTeX 写作命令"
        aria-modal="true"
        className="writing-command-palette"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((value) => filtered.length === 0 ? 0 : (value + 1) % filtered.length);
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((value) => filtered.length === 0 ? 0 : (value - 1 + filtered.length) % filtered.length);
          }
          if (event.key === "Enter") {
            event.preventDefault();
            run(filtered[boundedIndex]);
          }
        }}
        role="dialog"
      >
        <input
          aria-label="搜索写作命令"
          autoFocus
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          placeholder="输入命令，例如：编译、引用、定位…"
          value={query}
        />
        <div className="writing-command-list" role="listbox">
          {filtered.map((command, index) => (
            <button
              aria-disabled={command.disabled === true}
              aria-selected={index === boundedIndex}
              className={index === boundedIndex ? "active" : ""}
              disabled={command.disabled}
              key={command.id}
              onClick={() => run(command)}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
              type="button"
            >
              <span><strong>{command.label}</strong><small>{command.description}</small></span>
              {command.shortcut !== undefined && <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
          {filtered.length === 0 && <div className="writing-command-empty">没有匹配命令</div>}
        </div>
      </Dialog>
  );
}

export function filterWritingCommands(
  commands: readonly WritingCommand[],
  query: string,
): readonly WritingCommand[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return commands;
  return commands.filter((command) => (
    `${command.label} ${command.description}`.toLocaleLowerCase().includes(normalized)
  ));
}
