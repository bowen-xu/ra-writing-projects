import type { WritingGateway } from "./writingGateway";

const adapters = new WeakMap<WritingGateway, WritingGateway>();
const mutations = new Set<keyof WritingGateway>(["saveFile", "createFile", "renameFile", "deleteFile", "renameDirectory", "deleteDirectory",
  "createManuscript", "duplicateManuscript", "updateManuscript", "archiveManuscript", "restoreManuscript", "deleteManuscript", "importProject", "importResources"]);

/** Invalidate the unified index only after a successful source mutation. */
export function observeWritingNotes(source: WritingGateway): WritingGateway {
  const existing = adapters.get(source);
  if (existing) return existing;
  const methods = new Map<PropertyKey, unknown>();
  const adapter = new Proxy(source, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (!methods.has(key)) methods.set(key, async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(value, target, args);
        if (mutations.has(key as keyof WritingGateway)) window.dispatchEvent(new Event("research-assistant:writing-notes-changed"));
        return result;
      });
      return methods.get(key);
    },
  });
  adapters.set(source, adapter);
  // Application assembly may retain this already-observed port. Re-selecting
  // it must retain the same wrapper and dispatch one invalidation per write.
  adapters.set(adapter, adapter);
  return adapter;
}
