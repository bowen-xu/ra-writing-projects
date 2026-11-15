import {defineConfig, type Plugin} from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath} from "node:url";

const sdk = "@research-assistant/workbench-sdk";
const sdkLeaves = new Set([
  "agent-canvas", "agent-context", "agent-context-controls", "agent-conversations", "agent-delivery", "agent-diagnostics",
  "agent-drafts", "agent-gateways", "agent-presentation", "agent-submission", "agent-ui", "agent-writing", "ai-assistance",
  "block-content", "code-editor-extensions", "concept-retrieval", "configuration-hooks", "document-recovery", "document-windows",
  "domain-capabilities", "editor-review", "environment", "feedback", "git-versions", "git-worktrees", "note-documents", "overlay",
  "pdf", "platform", "source-navigation", "storage", "text-diff-stats", "ui", "workbench", "workspace-state", "writing-runtime", "writing-storage",
]);
const bareModules: Readonly<Record<string, string>> = {
  "@research-assistant/core/agent": "core-agent", "@research-assistant/core/citation": "core-citation",
  "@research-assistant/core/document-review": "core-document-review", "@research-assistant/core/literature": "core-literature",
  "@research-assistant/core/notes": "core-notes", "@research-assistant/core/hbs": "core-hbs", "@research-assistant/data/hbs": "data-hbs",
  "@codemirror/state": "codemirror-state", "@codemirror/view": "codemirror-view", "@codemirror/merge": "codemirror-merge",
  "@codemirror/commands": "codemirror-commands", "@codemirror/search": "codemirror-search", "@codemirror/language": "codemirror-language",
  "@codemirror/autocomplete": "codemirror-autocomplete", "@blocknote/react": "blocknote-react",
  "react": "react", "react/jsx-runtime": "react-jsx-runtime", "react/jsx-dev-runtime": "react-jsx-dev-runtime",
  "react-dom": "react-dom", "react-dom/client": "react-dom-client",
};
const sharedPath = (id: string): string | undefined => {
  if (id.startsWith(sdk + "/") && sdkLeaves.has(id.slice(sdk.length + 1))) return "/sdk/v1/" + id.slice(sdk.length + 1) + ".js";
  return bareModules[id] ? "/sdk/v1/" + bareModules[id] + ".js" : undefined;
};

function independentClosure(worker = false): Plugin {
  return {
    name: worker ? "writing-projects-worker-independent-closure" : "writing-projects-independent-closure",
    generateBundle() {
      const modules = [...this.getModuleIds()].filter(id => !id.startsWith("\0")).sort();
      const forbidden = modules.filter(id => /\/apps\/(?:web|desktop)\/|\/src\/(?:core|app)\/|\/node_modules\/(?:\.pnpm\/)?(?:react(?:@|\/)|react-dom(?:@|\/)|@codemirror\/(?:state|view|merge|commands|search|language|autocomplete)(?:@|\/)|@blocknote\/react(?:@|\/))|\/node_modules\/@research-assistant\/(?:core|data|workbench-sdk)\//u.test(id));
      if (forbidden.length) this.error("plugin_build_closure_violation:\n" + forbidden.join("\n"));
      this.emitFile({type: "asset", fileName: worker ? "worker-source-closure.json" : "source-closure.json", source: JSON.stringify({
        modules, sharedImports: modules.filter(id => sharedPath(id) !== undefined),
      }, null, 2)});
    },
  };
}

export default defineConfig({
  plugins: [react(), independentClosure()],
  worker: {format: "es", plugins: () => [independentClosure(true)]},
  build: {
    outDir: "build", emptyOutDir: true,
    lib: {entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)), formats: ["es"], fileName: () => "entry.js", cssFileName: "style"},
    rolldownOptions: {external: id => sharedPath(id) !== undefined, output: {paths: id => sharedPath(id) ?? id}},
  },
});
