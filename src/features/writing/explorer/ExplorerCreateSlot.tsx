import { FileCode2, FileText, Folder } from "lucide-react";

interface Props {
  readonly kind: "file" | "note" | "directory";
  readonly label: string;
  readonly value: string;
  readonly depth: number;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

export function ExplorerCreateSlot(props: Props): React.JSX.Element {
  const Icon = props.kind === "directory" ? Folder : props.kind === "note" ? FileText : FileCode2;
  return <form className="writing-create-slot" style={{ paddingLeft: 14 + props.depth * 14 }} onSubmit={event => { event.preventDefault(); if (props.value.trim()) props.onSubmit(); }}>
    <Icon size={17} />
    <input autoFocus onBlur={props.onCancel} aria-label={props.label} value={props.value} onChange={event => props.onChange(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onCancel(); } }} />
  </form>;
}
