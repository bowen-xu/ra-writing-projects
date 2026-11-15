import { WritingInstructionSettings } from "./agent/WritingInstructionSettings";
import { Code2, FileCog, Keyboard, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LatexEngine, LatexToolchainInfo, ManuscriptFile } from "@research-assistant/writing";
import type { EditorPreferences } from "./editor/editorPreferences";

interface WritingSettingsProps {
  readonly manuscriptId: string;
  readonly initialTab: "editor" | "compiler";
  readonly preferences: EditorPreferences;
  readonly onPreferencesChange: (change: Partial<EditorPreferences>) => void;
  readonly files: readonly ManuscriptFile[];
  readonly rootPath: string | undefined;
  readonly onRootChange: (path: string) => void;
  readonly engine: LatexEngine;
  readonly onEngineChange: (engine: LatexEngine) => void;
  readonly toolchain: LatexToolchainInfo | undefined;
  readonly isCompiling: boolean;
  readonly autoCompile: boolean;
  readonly onAutoCompileChange: (value: boolean) => void;
  readonly onClose: () => void;
}

export function WritingSettings(props: WritingSettingsProps): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<string>(props.initialTab);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return (
    <dialog className="writing-settings" ref={dialog} aria-labelledby="writing-settings-title" onCancel={props.onClose}>
      <header><h2 id="writing-settings-title">写作设置</h2><button aria-label="关闭写作设置" onClick={props.onClose} type="button"><X size={20} /></button></header>
      <div className="writing-settings-body">
        <nav aria-label="设置分类">
          {[{ id: "editor", label: "编辑器", icon: Code2 }, { id: "compiler", label: "编译器", icon: FileCog }, { id: "agent", label: "Agent", icon: Code2 }, { id: "shortcuts", label: "快捷键", icon: Keyboard }].map((item) => (
            <button key={item.id} className={tab === item.id ? "active" : ""} aria-pressed={tab === item.id} onClick={() => setTab(item.id)} type="button"><item.icon size={19} />{item.label}</button>
          ))}
        </nav>
        <section className="writing-settings-content" aria-label={tab === "editor" ? "编辑器设置" : tab === "compiler" ? "编译器设置" : tab === "agent" ? "Agent 设置" : "快捷键说明"}>
          {tab === "editor" && <>
            <h3>源码编辑</h3><p>调整阅读和输入习惯，设置会保留在当前设备。</p>
            <label><span><strong>字号</strong><small>只影响编辑器显示，不改变论文排版。</small></span><select aria-label="编辑器字号" value={props.preferences.fontSize} onChange={(event) => props.onPreferencesChange({ fontSize: Number(event.target.value) })}>{[12, 14, 16, 18, 20].map((size) => <option value={size} key={size}>{size} px</option>)}</select></label>
            <label><span><strong>自动换行</strong><small>长段落在编辑器宽度内折行。</small></span><input type="checkbox" role="switch" checked={props.preferences.lineWrapping} onChange={(event) => props.onPreferencesChange({ lineWrapping: event.target.checked })} /></label>
            <label><span><strong>显示行号</strong><small>在源码左侧显示行号。</small></span><input type="checkbox" role="switch" checked={props.preferences.showLineNumbers} onChange={(event) => props.onPreferencesChange({ showLineNumbers: event.target.checked })} /></label>
            <label><span><strong>缩进宽度</strong><small>按 Tab 时使用空格缩进。</small></span><select aria-label="缩进宽度" value={props.preferences.tabSize} onChange={(event) => props.onPreferencesChange({ tabSize: Number(event.target.value) })}><option value={2}>2 个空格</option><option value={4}>4 个空格</option></select></label>
          </>}
          {tab === "compiler" && <>
            <h3>编译设置</h3><p>使用当前设备已有的 LaTeX 环境生成 PDF。</p>
            <label><span><strong>主文档</strong><small>从这个文件开始编译整个稿件。</small></span><select aria-label="主文档" disabled={props.isCompiling} value={props.rootPath ?? ""} onChange={(event) => props.onRootChange(event.target.value)}>{props.files.filter((file) => file.kind === "tex").map((file) => <option key={file.relativePath} value={file.relativePath}>{file.relativePath}</option>)}</select></label>
            <label><span><strong>编译器</strong><small>仅可选择本机可用的引擎。</small></span><select aria-label="LaTeX engine" value={props.engine} disabled={props.isCompiling || !props.toolchain?.available} onChange={(event) => props.onEngineChange(event.target.value as LatexEngine)}>{(["pdflatex", "xelatex", "lualatex"] as const).map((engine) => <option value={engine} disabled={!props.toolchain?.supportedEngines.includes(engine)} key={engine}>{({ pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" })[engine]}</option>)}</select></label>
            <label><span><strong>自动编译</strong><small>修改保存成功后自动重新编译。</small></span><input type="checkbox" role="switch" checked={props.autoCompile} onChange={(event) => props.onAutoCompileChange(event.target.checked)} /></label>
            <div className="writing-setting-note" role="status">{props.toolchain === undefined ? "正在检测编译环境…" : props.toolchain.available ? "本机 LaTeX 环境已就绪。" : "编译环境不可用。请在桌面版中使用已安装的 TeX Live、MacTeX 或 MiKTeX。源码编辑和保存仍可使用。"}</div>
          </>}
          {tab === "agent" && <WritingInstructionSettings manuscriptId={props.manuscriptId} />}
          {tab === "shortcuts" && <>
            <h3>常用快捷键</h3><p>Mac 使用 Cmd，Windows / Linux 使用 Ctrl；大小写转换始终使用 Ctrl。</p>
            <dl className="writing-shortcut-list">{[
              ["接受补全", "Tab / Enter"], ["查找替换", "Cmd/Ctrl + F"], ["保存并编译", "Cmd/Ctrl + S 或 Cmd/Ctrl + Enter"],
              ["粗体 / 斜体", "Cmd/Ctrl + B / I"], ["删除当前行", "Cmd/Ctrl + D"], ["复制选区或行", "Cmd/Ctrl + Shift + D"],
              ["跳转行号", "Cmd/Ctrl + Shift + L"], ["大写 / 小写", "Ctrl + U / Ctrl + Shift + U"], ["命令面板", "Cmd/Ctrl + Shift + P"],
            ].map(([label, keys]) => <div key={label}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl>
          </>}
        </section>
      </div>
    </dialog>
  );
}
