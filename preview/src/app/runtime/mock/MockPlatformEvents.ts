import type {EventCallback} from "@tauri-apps/api/event";
import type {PlatformEvents} from "@research-assistant/workbench-preview/platform-events";

const supportedEvents = new Set(["research-writing-file-delivery", "research-writing-successor-workspace"]);

/** Instance-owned mock transport. Business listeners still decode and check scopes. */
export class MockPlatformEvents implements PlatformEvents {
  private readonly listeners = new Map<string, Map<number, (payload: unknown) => void>>();
  private sequence = 0;
  private disposed = false;
  private check(name: string): void {
    if (this.disposed) throw new Error("MOCK_PLATFORM_EVENTS_DISPOSED");
    if (!supportedEvents.has(name)) throw new Error(`预览未覆盖平台事件：${name}`);
  }
  async listen<T>(name: string, handler: EventCallback<T>): Promise<() => void> {
    this.check(name);
    const id = ++this.sequence, listeners = this.listeners.get(name) ?? new Map<number, (payload: unknown) => void>();
    listeners.set(id, (payload: unknown) => handler({event: name, id, payload: structuredClone(payload) as T}));
    this.listeners.set(name, listeners);
    return () => {listeners.delete(id); if (!listeners.size && this.listeners.get(name) === listeners) this.listeners.delete(name);};
  }
  emit(name: string, payload: unknown): void {
    this.check(name);
    for (const receive of [...(this.listeners.get(name)?.values() ?? [])]) receive(payload);
  }
  dispose(): void {this.disposed = true; this.listeners.clear();}
}
