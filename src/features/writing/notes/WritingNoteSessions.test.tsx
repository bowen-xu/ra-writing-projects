// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { writingNotePath } from "@research-assistant/writing";
import { WritingNoteSessions } from "./WritingNoteSessions";

const { mounts, callbacks } = vi.hoisted(() => ({ mounts: vi.fn(), callbacks: new Map<string, (value: string) => void>() }));
vi.mock("./WritingNoteEditor", () => ({ default: function Editor(props: { manuscriptId: string; content: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(props.content);
  useEffect(() => { mounts(props.manuscriptId); }, []);
  callbacks.set(props.manuscriptId, props.onChange);
  return <input aria-label={props.manuscriptId} value={value} onChange={event => { setValue(event.target.value); props.onChange(event.target.value); }} />;
} }));
it("retains same-path notes from different projects and rejects callbacks from the previous active project", async () => {
  const host = document.createElement("div"), root = createRoot(host), path = writingNotePath("Plan"), onChange = vi.fn();
  const retainedProjects = ["a", "b"].map(manuscriptId => ({ manuscriptId, openPaths: [path] }));
  const render = (manuscriptId: string, content: string) => act(async () => root.render(<WritingNoteSessions manuscriptId={manuscriptId}
    activePath={path} content={content} openPaths={[path]} retainedProjects={retainedProjects} onChange={onChange} />));
  try {
    await render("a", "A"); const first = host.querySelector('[aria-label="a"]'); const stale = callbacks.get("a")!;
    await render("b", "B");
    expect(host.querySelectorAll("input")).toHaveLength(2);
    expect(host.querySelector('[aria-label="a"]')).toBe(first);
    stale("late A"); expect(onChange).not.toHaveBeenCalled();
    await render("a", "late A");
    expect(host.querySelector('[aria-label="a"]')).toBe(first);
    expect(mounts.mock.calls.map(call => call[0])).toEqual(["a", "b"]);
  } finally { await act(async () => root.unmount()); }
});
