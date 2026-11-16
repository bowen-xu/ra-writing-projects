import { decodeAgentEvidenceInput, type AgentEvidenceImage } from "@research-assistant/core/agent";
import type { NotesGateway } from "@research-assistant/data/notes";

const key = "agent-evidence-images";
const commands = new Set(["agent_pin_evidence_image", "agent_read_evidence_image", "agent_release_evidence_image", "agent_reconcile_evidence_drafts"]);

/** Preview owns capture handles in isolated storage and reuses its managed assets. */
export function createMockEvidenceImages(storage: Storage, notes: Pick<NotesGateway, "readNoteAsset">) {
  function records(): Record<string, { image: AgentEvidenceImage; held: boolean }> {
    return JSON.parse(storage.getItem(key) ?? "{}") as Record<string, { image: AgentEvidenceImage; held: boolean }>;
  }
  function image(value: unknown): AgentEvidenceImage {
    const reference = decodeAgentEvidenceInput({ type: "annotation", source: "source://notes/preview", title: "图片", text: "", comment: "", image: value });
    if (reference.type !== "annotation" || !reference.image) throw new Error("图片引用无效");
    return reference.image;
  }
  async function read(reference: AgentEvidenceImage): Promise<number[]> {
    const stored = records()[reference.captureId]?.image;
    if (!stored || stored.assetId !== reference.assetId || stored.mediaType !== reference.mediaType || stored.byteSize !== reference.byteSize) throw new Error("图片快照不可用");
    const bytes = await notes.readNoteAsset(reference.assetId);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const prefix = (signature: readonly number[]) => signature.every((byte, index) => bytes[index] === byte);
    const signature = reference.mediaType === "image/png" ? prefix([137, 80, 78, 71, 13, 10, 26, 10])
      : reference.mediaType === "image/jpeg" ? prefix([255, 216, 255])
      : prefix([82, 73, 70, 70]) && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
    if (bytes.length !== reference.byteSize || hash !== reference.assetId || !signature) throw new Error("图片快照已损坏");
    return [...bytes];
  }
  return {
    handles: (command: string) => commands.has(command),
    async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
      const entries = records();
      if (command === "agent_pin_evidence_image") {
        const request = args?.request;
        if (!request || typeof request !== "object") throw new Error("图片引用无效");
        const reference = image({ ...request, captureId: crypto.randomUUID() });
        entries[reference.captureId] = { image: reference, held: true };
        storage.setItem(key, JSON.stringify(entries));
        try { await read(reference); } catch (reason) { delete entries[reference.captureId]; storage.setItem(key, JSON.stringify(entries)); throw reason; }
        return reference;
      }
      if (command === "agent_read_evidence_image") return read(image(args?.request));
      if (command === "agent_release_evidence_image") {
        const entry = entries[String(args?.captureId)];
        if (entry) entry.held = false;
      } else if (command === "agent_reconcile_evidence_drafts") {
        if (!Array.isArray(args?.captureIds) || args.captureIds.length > 65536 || !args.captureIds.every(id => typeof id === "string")) throw new Error("图片草稿无效");
        const retained = new Set(args.captureIds);
        for (const entry of Object.values(entries)) entry.held = retained.has(entry.image.captureId);
      } else throw new Error(`预览未覆盖平台调用：${command}`);
      // Release affects draft ownership only; sent/queued snapshots remain readable.
      storage.setItem(key, JSON.stringify(entries));
    },
  };
}
