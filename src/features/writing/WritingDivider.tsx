import { ControlHint } from "@research-assistant/workbench-sdk/overlay";
import { ChevronLeft, ChevronRight, ArrowLeft, ArrowRight } from "lucide-react";
import type { KeyboardEvent, PointerEvent } from "react";

export interface WritingSyncActions {
  readonly forward: () => void;
  readonly backward: () => void;
  readonly forwardDisabled: string | undefined;
  readonly backwardDisabled: string | undefined;
}

export function WritingSyncButton({ direction, actions, className = "" }: { readonly direction: "forward" | "backward"; readonly actions: WritingSyncActions; readonly className?: string }): React.JSX.Element {
  const forward = direction === "forward";
  const label = forward ? "源码定位到 PDF" : "PDF 定位到源码";
  const disabled = forward ? actions.forwardDisabled : actions.backwardDisabled;
  return <ControlHint content={disabled ?? label}><span className={className}><button type="button" aria-label={label} disabled={disabled !== undefined} onMouseDown={(event) => event.preventDefault()} onClick={forward ? actions.forward : actions.backward}>{forward ? <ArrowRight size={19} /> : <ArrowLeft size={19} />}</button></span></ControlHint>;
}

interface Props {
  readonly edge: "explorer" | "preview";
  readonly collapsed: boolean;
  readonly direction: "left" | "right";
  readonly label: string;
  readonly width: number;
  readonly onToggle: () => void;
  readonly onResize: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onKeyResize: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly sync?: WritingSyncActions;
}

export function WritingDivider(props: Props): React.JSX.Element {
  const file = props.edge === "explorer";
  return <div className={"writing-divider " + props.edge} data-collapsed={props.collapsed}>
    {!props.collapsed && <ControlHint content="拖动调整宽度；方向键微调"><div className="writing-divider-drag" role="separator" aria-label={file ? "调整文件面板宽度" : "调整预览面板宽度"} aria-orientation="vertical" aria-valuemin={file ? 160 : 280} aria-valuemax={file ? 380 : 720} aria-valuenow={props.width} tabIndex={0} onPointerDown={props.onResize} onKeyDown={props.onKeyResize}><span className="writing-divider-grip grip-top" aria-hidden="true" /><span className="writing-divider-grip grip-bottom" aria-hidden="true" /></div></ControlHint>}
    {props.sync && <div className="writing-divider-sync"><WritingSyncButton direction="forward" actions={props.sync} /><WritingSyncButton direction="backward" actions={props.sync} /></div>}
    <ControlHint content={props.label}><button className="writing-divider-toggle" type="button" aria-label={props.label} onClick={props.onToggle}>{props.direction === "left" ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}</button></ControlHint>
  </div>;
}
