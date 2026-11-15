import {createContext, useContext, useSyncExternalStore, type ReactNode} from "react";
import type {PluginWritingRuntimeProps} from "@research-assistant/workbench-sdk/activation";

export type WritingRuntimeAdmission = Pick<PluginWritingRuntimeProps, "isDisabled" | "subscribe">;

const staticAdmission: WritingRuntimeAdmission = {
  isDisabled: () => false,
  subscribe: () => () => undefined,
};
const Context = createContext<WritingRuntimeAdmission>(staticAdmission);

/** A captured instance supplies its original lifecycle observation. */
export function WritingRuntimeAdmissionScope({value, children}: {
  readonly value: WritingRuntimeAdmission;
  readonly children: ReactNode;
}): React.JSX.Element {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useWritingRuntimeAdmission() {
  const admission = useContext(Context);
  const disabled = useSyncExternalStore(admission.subscribe, admission.isDisabled);
  return {disabled, isDisabled: admission.isDisabled};
}

export function writingRuntimeAdmission(value: WritingRuntimeAdmission | undefined): WritingRuntimeAdmission {
  return value ?? staticAdmission;
}
