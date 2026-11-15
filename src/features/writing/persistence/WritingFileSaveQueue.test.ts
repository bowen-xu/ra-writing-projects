import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { parseManuscriptPath, type ManuscriptFileContent, type WritingCheckpointRecord } from "@research-assistant/writing";
import { WritingFileSessions } from "../editor/writingFileSessions";
import { createMemoryWritingCheckpointGateway } from "../gateway/writingCheckpointGateway";
import type { WritingGateway } from "../gateway";
import { WritingCheckpointPersistence } from "./WritingCheckpointPersistence";
import { WritingFileSaveQueue } from "./WritingFileSaveQueue";
import { prepareWritingClose } from "./writingCloseBoundary";

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function disk(path: string, content: string): ManuscriptFileContent { return { relativePath: parseManuscriptPath(path), content, sha256: hash(content) }; }
afterEach(() => vi.useRealTimers());
it('debounces ordinary source edits for three seconds and saves ordinary edits immediately on close', async () => {
  vi.useFakeTimers();
  const host = await setup();
  try {
    for (let index = 0; index < 5; index++) {
      host.one.dispatch({ changes: { from: 0, insert: 'a' }, userEvent: 'input.type' });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(host.gateway.saveFile).not.toHaveBeenCalled();
    expect(host.checkpointGateway.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(host.gateway.saveFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.gateway.saveFile).toHaveBeenCalledOnce();
    expect(host.disks.get('one.tex')?.content).toBe('aaaaaold one');
    host.two.dispatch({ changes: { from: 0, insert: 'close ' }, userEvent: 'input.type' });
    expect(await prepareWritingClose({ ...host, flushSession: async () => undefined, onFailure: vi.fn(), onRecoverable: vi.fn() })).toBe(true);
    expect(host.disks.get('two.tex')?.content).toBe('close old two');
    await vi.advanceTimersByTimeAsync(3000);
    expect(host.gateway.saveFile).toHaveBeenCalledTimes(2);
  } finally { host.dispose(); }
});

it('defers input made during an automatic file write until its own three second deadline', async () => {
  vi.useFakeTimers();
  const host = await setup();
  let finish!: () => void;
  vi.mocked(host.gateway.saveFile).mockImplementationOnce(async request => {
    await new Promise<void>(resolve => { finish = resolve; });
    const saved = disk(request.relativePath, request.content); host.disks.set(request.relativePath, saved); return saved;
  });
  try {
    host.one.dispatch({ changes: { from: 0, insert: 'a' }, userEvent: 'input.type' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(host.gateway.saveFile).toHaveBeenCalledOnce();
    host.one.dispatch({ changes: { from: 0, insert: 'b' }, userEvent: 'input.type' });
    await vi.advanceTimersByTimeAsync(1000); finish(); await vi.advanceTimersByTimeAsync(0);
    expect(host.gateway.saveFile).toHaveBeenCalledOnce();
    expect(host.disks.get('one.tex')?.content).toBe('aold one');
    await vi.advanceTimersByTimeAsync(1999);
    expect(host.gateway.saveFile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.gateway.saveFile).toHaveBeenCalledTimes(2);
    expect(host.disks.get('one.tex')?.content).toBe('baold one');
  } finally { host.dispose(); }
});
async function setup() {
  const storage = new Map<string, WritingCheckpointRecord>(), files = new WritingFileSessions(), errors = vi.fn();
  const adapter = createMemoryWritingCheckpointGateway(storage);
  const checkpointGateway = { list: vi.fn(adapter.list), save: vi.fn(adapter.save) };
  const checkpoints = new WritingCheckpointPersistence(files, checkpointGateway, errors, async (content) => hash(content));
  const disconnectCheckpoints = checkpoints.connect();
  const disks = new Map([['one.tex', disk('one.tex', 'old one')], ['two.tex', disk('two.tex', 'old two')]]);
  const gateway: Pick<WritingGateway, 'readFile' | 'saveFile'> = {
    readFile: vi.fn(async (_manuscript, path) => disks.get(path)!),
    saveFile: vi.fn(async (request) => {
      if (request.expectedSha256 !== disks.get(request.relativePath)?.sha256) throw Object.assign(new Error("external edit"), { code: "file_conflict" });
      const saved = disk(request.relativePath, request.content); disks.set(request.relativePath, saved); return saved;
    }),
  };
  const one = await checkpoints.open('m', disks.get('one.tex')!), two = await checkpoints.open('m', disks.get('two.tex')!);
  const saves = new WritingFileSaveQueue(files, checkpoints, gateway, errors);
  const disconnectSaves = saves.connect();
  return { files, checkpoints, checkpointGateway, saves, gateway, disks, storage, one, two, errors,
    dispose: () => { disconnectSaves(); disconnectCheckpoints(); } };
}
it('saves an unopened file immediately and retains its pending diff', async () => {
  const host = await setup();
  host.two.applyAgent('operation', 0, 'new two');
  await host.saves.save(host.two.identity);
  expect(host.two.hasBeenOpened).toBe(false);
  expect(host.disks.get('two.tex')?.content).toBe('new two');
  expect(host.two.pending).toBe(true);
  expect(host.checkpoints.isSaved(host.two.identity)).toBe(true);
  host.two.resolveAll('keep');
  await host.saves.save(host.two.identity);
  expect([...host.storage.values()].find((row) => row.checkpoint.relativePath === 'two.tex')?.checkpoint).toMatchObject({
    content: 'new two', reviewBaseline: 'new two', savedVersion: 2 });
  host.dispose();
});
it('returns Agent save errors without notifications and still reports manual save errors', async () => {
  const host = await setup();
  const failure = new Error('disk unavailable');
  vi.mocked(host.gateway.saveFile).mockRejectedValue(failure);
  const release = await host.saves.pause();
  host.two.applyAgent('agent-operation', 0, 'new two');
  release();
  await expect(host.saves.save(host.two.identity)).rejects.toBe(failure);
  expect(host.errors).not.toHaveBeenCalled();
  expect(host.two.read().content).toBe('new two');
  expect(host.checkpoints.isSaved(host.two.identity)).toBe(false);
  host.two.dispatch({ changes: { from: host.two.state.doc.length, insert: ' manual' }, userEvent: 'input.type' });
  await expect(host.saves.save(host.two.identity)).rejects.toBe(failure);
  expect(host.errors).toHaveBeenCalledExactlyOnceWith(failure, host.two.identity);
  expect(host.two.read().content).toBe('new two manual');
  host.dispose();
});
it('shares one in-flight write and drains newer text and baseline versions without losing them', async () => {
  const host = await setup();
  let started!: () => void, finish!: (result: ManuscriptFileContent) => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(host.gateway.saveFile).mockImplementationOnce(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
  host.one.applyAgent('operation', 0, 'new one');
  const first = host.saves.save(host.one.identity);
  await dispatched;
  expect(host.saves.save(host.one.identity)).toBe(first);
  host.one.resolveAll('keep');
  host.one.dispatch({ changes: { from: 7, insert: ' manual' }, userEvent: 'input.type' });
  host.disks.set('one.tex', disk('one.tex', 'new one')); finish(host.disks.get('one.tex')!);
  expect((await first).content).toBe('new one manual');
  expect(vi.mocked(host.gateway.saveFile).mock.calls.map(([request]) => request.content)).toEqual(['new one', 'new one manual']);
  expect(host.checkpoints.isSaved(host.one.identity)).toBe(true);
  host.dispose();
});
it('pauses admission across all files and resumes headless pending changes only after the last lease releases', async () => {
  const host = await setup();
  const release = await host.saves.pause(), inner = await host.saves.pause();
  host.one.applyAgent('one', 0, 'new one'); host.two.applyAgent('two', 0, 'new two');
  await host.checkpoints.flushAll();
  expect(host.gateway.saveFile).not.toHaveBeenCalled();
  release(); release();
  expect(host.gateway.saveFile).not.toHaveBeenCalled();
  inner();
  await host.saves.flushAll();
  expect(host.disks.get('one.tex')?.content).toBe('new one');
  expect(host.disks.get('two.tex')?.content).toBe('new two');
  host.dispose();
});
it('flushes both files before closing and restores partial review from independent durable storage', async () => {
  vi.useFakeTimers(); const host = await setup();
  const release = await host.saves.pause();
  host.one.applyAgent('one', 0, 'new one'); host.two.applyAgent('two', 0, 'new two');
  host.one.resolveAll('keep'); release();
  const flushSession = vi.fn().mockResolvedValue(undefined), onFailure = vi.fn(), onRecoverable = vi.fn();
  expect(await prepareWritingClose({ ...host, flushSession, onFailure, onRecoverable })).toBe(true);
  expect(flushSession).toHaveBeenCalledOnce(); expect(onFailure).not.toHaveBeenCalled();
  const restored = new WritingFileSessions();
  const second = new WritingCheckpointPersistence(restored, createMemoryWritingCheckpointGateway(host.storage), vi.fn(), async (value) => hash(value));
  const disconnect = second.connect();
  expect((await second.open('m', host.disks.get('one.tex')!)).pending).toBe(false);
  expect((await second.open('m', host.disks.get('two.tex')!)).pending).toBe(true);
  host.dispose(); disconnect();
});
it('allows close after formal saves fail only when full checkpoints remain reliable', async () => {
  const host = await setup();
  vi.mocked(host.gateway.saveFile).mockRejectedValue(new Error('disk unavailable'));
  host.two.applyAgent('operation', 0, 'new two'); host.two.resolveAll('keep');
  const onRecoverable = vi.fn(), onFailure = vi.fn(), flushSession = vi.fn().mockResolvedValue(undefined);
  expect(await prepareWritingClose({ ...host, flushSession, onFailure, onRecoverable })).toBe(true);
  expect(onRecoverable).toHaveBeenCalledOnce(); expect(onFailure).not.toHaveBeenCalled();
  expect([...host.storage.values()].find((row) => row.checkpoint.relativePath === 'two.tex')?.checkpoint).toMatchObject({
    content: 'new two', reviewBaseline: 'new two', savedSha256: hash('old two') });
  host.dispose();
});
it('blocks close and preserves working state when formal saves and recovery checkpoints both fail', async () => {
  const host = await setup();
  host.checkpointGateway.save.mockRejectedValue(new Error('database unavailable'));
  vi.mocked(host.gateway.saveFile).mockRejectedValue(new Error('disk unavailable'));
  host.two.applyAgent('operation', 0, 'new two'); host.two.resolveAll('keep');
  const onRecoverable = vi.fn(), onFailure = vi.fn(), flushSession = vi.fn().mockResolvedValue(undefined);
  expect(await prepareWritingClose({ ...host, flushSession, onFailure, onRecoverable })).toBe(false);
  expect(onFailure).toHaveBeenCalledOnce(); expect(flushSession).not.toHaveBeenCalled(); expect(onRecoverable).not.toHaveBeenCalled();
  expect(host.two.read()).toMatchObject({ content: 'new two', reviewBaseline: 'new two' });
  // Disconnection reports its failing final checkpoint instead of clearing the buffer.
  host.dispose();
});

it('allows close after session preference storage fails when the full document checkpoint is reliable', async () => {
  const host = await setup(), onRecoverable = vi.fn(), onFailure = vi.fn();
  host.one.applyAgent('operation', 0, 'new one');
  expect(await prepareWritingClose({ ...host, onRecoverable, onFailure,
    flushSession: vi.fn().mockRejectedValue(new Error('preferences unavailable')) })).toBe(true);
  expect(onRecoverable).toHaveBeenCalledOnce(); expect(onFailure).not.toHaveBeenCalled();
  expect(host.checkpoints.isSaved(host.one.identity)).toBe(true);
  host.dispose();
});

it('reconciles a lost formal acknowledgement without writing the same file twice', async () => {
  const host = await setup();
  vi.mocked(host.gateway.saveFile).mockImplementationOnce(async (request) => {
    host.disks.set(request.relativePath, disk(request.relativePath, request.content));
    throw new Error('acknowledgement lost');
  });
  host.one.applyAgent('operation', 0, 'new one');
  await expect(host.saves.save(host.one.identity)).rejects.toThrow('acknowledgement lost');
  expect((await host.saves.save(host.one.identity)).content).toBe('new one');
  expect(host.gateway.saveFile).toHaveBeenCalledOnce();
  expect(host.checkpoints.isSaved(host.one.identity)).toBe(true);
  expect(host.one.pending).toBe(true);
  host.dispose();
});
it('never overwrites an external file and can reliably recover the conflicting working draft on close', async () => {
  const host = await setup(), release = await host.saves.pause();
  host.two.applyAgent('operation', 0, 'new two');
  host.disks.set('two.tex', disk('two.tex', 'external'));
  release();
  expect(await host.saves.flushAll()).toHaveLength(1);
  const onFailure = vi.fn(), onRecoverable = vi.fn();
  expect(await prepareWritingClose({ ...host, onFailure, onRecoverable, flushSession: async () => undefined })).toBe(true);
  expect(host.disks.get('two.tex')?.content).toBe('external');
  expect(host.two.read()).toMatchObject({ content: 'new two', reviewBaseline: 'old two' });
  expect([...host.storage.values()].find((row) => row.checkpoint.relativePath === 'two.tex')?.checkpoint).toMatchObject({ content: 'new two', reviewBaseline: 'old two' });
  expect(onRecoverable).toHaveBeenCalledOnce(); expect(onFailure).not.toHaveBeenCalled();
  host.dispose();
});
it('finishes an in-flight file write before granting a pause and delays newer input until release', async () => {
  const host = await setup();
  let started!: () => void, finish!: (result: ManuscriptFileContent) => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(host.gateway.saveFile).mockImplementationOnce(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
  host.one.applyAgent('operation', 0, 'new one');
  const saving = host.saves.save(host.one.identity); await dispatched;
  const pausing = host.saves.pause();
  host.one.dispatch({ changes: { from: 7, insert: ' manual' }, userEvent: 'input.type' });
  host.disks.set('one.tex', disk('one.tex', 'new one')); finish(host.disks.get('one.tex')!);
  const release = await pausing; await saving;
  expect(host.gateway.saveFile).toHaveBeenCalledOnce();
  expect(host.disks.get('one.tex')?.content).toBe('new one');
  release(); await host.saves.flushAll();
  expect(host.disks.get('one.tex')?.content).toBe('new one manual');
  host.dispose();
});
