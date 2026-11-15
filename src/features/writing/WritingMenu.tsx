import type { ComponentProps } from "react";
import { ActionMenu } from "@research-assistant/workbench-sdk/overlay";
export { ActionMenuItem as WritingMenuItem } from "@research-assistant/workbench-sdk/overlay";

/** Writing commands may own a follow-up input or transfer surface inside the menu. */
export function WritingMenu(props: ComponentProps<typeof ActionMenu>): React.JSX.Element {
  return <ActionMenu keepMounted {...props} />;
}
