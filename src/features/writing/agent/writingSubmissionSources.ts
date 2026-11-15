import type { AgentEditorSnapshot, AgentWorkspaceBuffer, AgentWritingContextFile } from "@research-assistant/core/agent";
import { isWritingSourcePath, type ManuscriptFile } from "@research-assistant/writing";
import type { WritingFileSessions } from "../editor/writingFileSessions";
import type { WritingGateway } from "../gateway";

/** Observe disk for disclosure without changing saved baselines or settling a
 * previous operation. A lost save reply can leave S stale while disk equals D.
 * Unrelated external bytes still fail; this is never write authorization. */
export async function readWritingSubmissionBuffers(manuscriptId: string, files: WritingFileSessions,
  gateway: Pick<WritingGateway, "readFile">): Promise<readonly AgentWorkspaceBuffer[]> {
  const buffers = files.readBuffers(manuscriptId);
  const observed = await Promise.all(buffers.map(async buffer => {
    const disk = await gateway.readFile(manuscriptId, buffer.path);
    if (disk.sha256 !== buffer.expectedDiskSha256 && disk.content !== buffer.text) throw new Error("文件已有外部修改，请先核对版本。");
    return { ...buffer, expectedDiskSha256: disk.sha256 };
  }));
  const current = files.readBuffers(manuscriptId);
  if (current.length !== buffers.length || buffers.some(buffer => !current.some(value => value.path === buffer.path
    && value.sessionId === buffer.sessionId && value.revision === buffer.revision && value.text === buffer.text))) throw new Error("文件内容正在变化，请重新发送。");
  return observed;
}

/** Freeze selected current documents once, before any asynchronous preparation. */
export function captureWritingSubmissionSources(options: {
  readonly manuscriptId: string;
  readonly files: readonly ManuscriptFile[];
  readonly referencedPaths?: readonly string[] | undefined;
  readonly contextScope: "manuscript" | "current-file";
  readonly activePath: string | undefined;
  readonly content: string;
  readonly contentHash: string | undefined;
  readonly editor: AgentEditorSnapshot | null;
  readonly fileBuffers: readonly AgentWorkspaceBuffer[] | undefined;
}): { readonly contextFiles: readonly AgentWritingContextFile[]; readonly buffers: readonly AgentWorkspaceBuffer[] } {
  const { activePath, editor } = options;
  const selected = options.files.filter((file) => isWritingSourcePath(file.relativePath)
    && (options.contextScope === "manuscript" || file.relativePath === activePath || options.referencedPaths?.includes(file.relativePath)));
  if (!selected.length) throw new Error("当前范围没有可读取的稿件源码。");
  const hasActive = selected.some((file) => file.relativePath === activePath);
  if (hasActive && !options.contentHash) throw new Error("当前文件尚未加载完成，请稍后重试。");
  if (hasActive && (!editor || editor.documentKey !== `${options.manuscriptId}:${activePath}` || editor.text !== options.content)) {
    throw new Error("编辑器内容正在切换，请稍后重试。");
  }
  const current = new Map<string, AgentWorkspaceBuffer>();
  for (const buffer of options.fileBuffers ?? []) {
    if (current.has(buffer.path)) throw new Error("文件缓冲区身份重复，请重新核对后重试。");
    current.set(buffer.path, { ...buffer });
  }
  if (hasActive && editor && activePath && options.contentHash) {
    const buffer = current.get(activePath);
    if (options.fileBuffers !== undefined && (!buffer || buffer.sessionId !== editor.sessionId
      || buffer.revision !== editor.revision || buffer.text !== editor.text)) {
      throw new Error("编辑器内容正在切换，请稍后重试。");
    }
    if (!buffer) current.set(activePath, { path: activePath, expectedDiskSha256: options.contentHash,
      sessionId: editor.sessionId, revision: editor.revision, text: editor.text });
  }
  const contextFiles = selected.map((file): AgentWritingContextFile => {
    const buffer = current.get(file.relativePath);
    return { relativePath: file.relativePath, expectedDiskSha256: buffer?.expectedDiskSha256 ?? file.sha256,
      ...(buffer ? { buffer: { revision: buffer.revision, text: buffer.text } } : {}),
      ...(file.relativePath === activePath && editor?.selection ? { selection: { ...editor.selection } } : {}) };
  });
  // Native execution copies already contain the manuscript tree. Cover every
  // live source buffer there without expanding the selected model context.
  return { contextFiles, buffers: [...current.values()] };
}
