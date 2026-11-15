/** @vitest-environment happy-dom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {useWritingMetadataSend} from "./useWritingMetadataSend";

vi.mock("../../../../../../apps/web/src/core/services/notifications", () => ({notify: {error: vi.fn()}}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

it("resumes one captured send only after the adopted conversation is ready", async () => {
  const host = document.createElement("div"), root = createRoot(host), send = vi.fn(async (_text: string) => {});
  let control!: ReturnType<typeof useWritingMetadataSend<[string]>>;
  function Probe({ready, active = true, issue}: {ready: boolean; active?: boolean; issue?: string}) {
    control = useWritingMetadataSend({loading: false, issue, ready, active, retry: undefined, send});
    return null;
  }
  try {
    await act(async () => root.render(<Probe ready={false} />));
    await act(async () => {control.wait(["original"], true);});
    expect(send).not.toHaveBeenCalled();
    await act(async () => root.render(<Probe ready />));
    expect(send).toHaveBeenCalledExactlyOnceWith("original");
    await act(async () => root.render(<Probe ready={false} />));
    await act(async () => {control.wait(["failed"], true);});
    await act(async () => root.render(<Probe ready={false} issue="无法读取" />));
    await act(async () => root.render(<Probe ready />));
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Probe ready={false} />));
    await act(async () => {control.wait(["old"], true);});
    await act(async () => root.render(<Probe ready={false} active={false} />));
    await act(async () => root.render(<Probe ready />));
    expect(send).toHaveBeenCalledTimes(1);
  } finally {await act(async () => root.unmount());}
});
