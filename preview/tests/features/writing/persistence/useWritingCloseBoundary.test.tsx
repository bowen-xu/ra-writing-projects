/** @vitest-environment happy-dom */
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { getReaderCloseCoordinator } from "@research-assistant/workbench-preview/workbench-c5927e";
import { useWritingCloseBoundary } from "@research-assistant/writing-projects-preview/use-writing-close-boundary";

vi.mock("@research-assistant/workbench-preview/notifications", () => ({ notify: { error: vi.fn(), warning: vi.fn() } }));
type Options = Parameters<typeof useWritingCloseBoundary>[0];
function options(): Options {
  const flushSession = vi.fn().mockResolvedValue(undefined);
  return { activePath: "main.tex", saveCurrent: vi.fn().mockResolvedValue(true),
    persistCurrent: Object.assign(vi.fn().mockResolvedValue(true), { pause: vi.fn(), flushSession }),
    fileSaves: { flushAll: vi.fn().mockResolvedValue([]) } as unknown as Options["fileSaves"],
    checkpoints: { flushAll: vi.fn().mockResolvedValue(undefined) } as unknown as Options["checkpoints"] };
}
it("registers one StrictMode close participant, reads latest callbacks and leaves reader tab ownership unchanged", async () => {
  const root = createRoot(document.createElement('div')), first = options(), next = options();
  function Host({ value }: { value: Options }) { useWritingCloseBoundary(value); return null; }
  try {
    await act(async () => root.render(<StrictMode><Host value={first} /></StrictMode>));
    await act(async () => root.render(<StrictMode><Host value={next} /></StrictMode>));
    expect(getReaderCloseCoordinator().hasActive()).toBe(false);
    expect(await getReaderCloseCoordinator().prepareAll()).toBe(true);
    expect(first.fileSaves.flushAll).not.toHaveBeenCalled();
    expect(next.fileSaves.flushAll).toHaveBeenCalledOnce();
    expect(next.checkpoints.flushAll).toHaveBeenCalledOnce();
    expect(next.persistCurrent.flushSession).toHaveBeenCalledOnce();
    expect(vi.mocked(next.fileSaves.flushAll).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(next.checkpoints.flushAll).mock.invocationCallOrder[0]!);
  } finally { await act(async () => root.unmount()); }
  expect(await getReaderCloseCoordinator().prepareAll()).toBe(true);
  expect(next.fileSaves.flushAll).toHaveBeenCalledOnce();
});
it("keeps close available through reliable recovery, but blocks and permits retry after checkpoint failure", async () => {
  const root = createRoot(document.createElement('div')), value = options();
  function Host() { useWritingCloseBoundary(value); return null; }
  vi.mocked(value.fileSaves.flushAll).mockResolvedValue([new Error('formal save failed')]);
  try {
    await act(async () => root.render(<Host />));
    expect(await getReaderCloseCoordinator().prepareAll()).toBe(true);
    vi.mocked(value.checkpoints.flushAll).mockRejectedValueOnce(new Error('recovery unavailable'));
    expect(await getReaderCloseCoordinator().prepareAll()).toBe(false);
    expect(await getReaderCloseCoordinator().prepareAll()).toBe(true);
  } finally { await act(async () => root.unmount()); }
});
it("does not close through an unfinished Writing Note attachment or invalid note encoding", async () => {
  const root = createRoot(document.createElement('div')), value = { ...options(), activePath: 'notes/note.ranote' };
  vi.mocked(value.saveCurrent).mockResolvedValue(false);
  function Host() { useWritingCloseBoundary(value); return null; }
  try {
    await act(async () => root.render(<Host />));
    expect(await getReaderCloseCoordinator().prepareAll()).toBe(false);
    expect(value.fileSaves.flushAll).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("drains application-owned file work before saving and keeps the owner alive when it is still busy", async () => {
  const root = createRoot(document.createElement("div")), prepareFileTasks = vi.fn().mockResolvedValue(false);
  const value = {...options(), prepareFileTasks};
  function Host() {useWritingCloseBoundary(value); return null;}
  try {
    await act(async () => root.render(<Host/>));
    expect(await getReaderCloseCoordinator().prepareAll()).toBe(false);
    expect(value.fileSaves.flushAll).not.toHaveBeenCalled();
    prepareFileTasks.mockResolvedValue(true);
    expect(await getReaderCloseCoordinator().prepareAll()).toBe(true);
    expect(prepareFileTasks.mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(value.fileSaves.flushAll).mock.invocationCallOrder[0]!);
  } finally {await act(async () => root.unmount());}
});

it("publishes readiness after registration and withdraws it before the exact close participant", async () => {
  const root = createRoot(document.createElement("div")), value = options();
  const preparedAtPublish: Promise<boolean>[] = [], preparedAtRelease: Promise<boolean>[] = [];
  const release = vi.fn(() => {preparedAtRelease.push(getReaderCloseCoordinator().prepareAll());});
  const onRegistered = vi.fn(() => {
    preparedAtPublish.push(getReaderCloseCoordinator().prepareAll());
    return release;
  });
  function Host() {useWritingCloseBoundary({...value, onRegistered}); return null;}
  await act(async () => root.render(<StrictMode><Host/></StrictMode>));
  expect(onRegistered).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  expect(release).toHaveBeenCalledTimes(2);
  expect(await Promise.all([...preparedAtPublish, ...preparedAtRelease])).toEqual([true, true, true, true]);
  expect(value.fileSaves.flushAll).toHaveBeenCalledTimes(4);
  expect(await getReaderCloseCoordinator().prepareAll()).toBe(true);
  expect(value.fileSaves.flushAll).toHaveBeenCalledTimes(4);
});
