import type { PreviewControls } from "@research-assistant/workbench-preview/app-runtime";

export function monitorMockGateway<T extends object>(gateway: T, controls: PreviewControls,
  persist: () => void = () => undefined): T {
  return new Proxy(gateway, { get(target, property) {
    const value: unknown = Reflect.get(target, property);
    if (typeof value !== "function") return value;
    return async (...args: unknown[]) => {
      const name = String(property);
      // Long poll reads retain their existing cancellation/lifecycle contracts.
      const operation = /save|create|delete|rename|archive|mutate|confirm|apply|execute|bind/i.test(name) ? "save"
        : /compile/i.test(name) ? "compile" : /prepareWriting|startWriting/.test(name) ? "agent" : null;
      if (operation) await controls.beforeOperation(operation);
      try { return await value.apply(target, args); }
      finally { persist(); }
    };
  } });
}
