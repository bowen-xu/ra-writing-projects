import { registerAppStoragePrefix } from "@research-assistant/workbench-preview/app-storage";

/** Isolated data port for standalone mock harnesses; production owners still flush/check it. */
export function createMockAgentRecoveryStorage(namespace: string, beforeWrite?: () => void): Storage {
  const values = new Map<string, string>();
  const storage: Storage = {get length() {return values.size;}, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => {beforeWrite?.(); values.set(key, value);},
    removeItem: key => {values.delete(key);}, clear: () => values.clear()};
  registerAppStoragePrefix(storage, `research-assistant.mock-recovery:${namespace}:${crypto.randomUUID()}:`);
  return storage;
}
