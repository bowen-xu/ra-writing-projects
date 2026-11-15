import type { ReactNode } from "react";
import { WritingMenu } from "../WritingMenu";

export function PreviewMenu({ label, trigger, children, className = "" }: { readonly label: string; readonly trigger: ReactNode; readonly children: ReactNode; readonly className?: string }): React.JSX.Element {
  return <WritingMenu label={label} trigger={trigger} className={`writing-preview-menu ${className}`} contentClassName="writing-preview-menu-content">{children}</WritingMenu>;
}
