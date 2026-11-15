import type { WritingCommand } from "./WritingCommandPalette";

interface WritingCommandOptions {
  readonly autoCompile: boolean;
  readonly canCompile: boolean;
  readonly canInsertCitation: boolean;
  readonly canLocatePdf: boolean;
  readonly canSave: boolean;
  readonly isCompiling: boolean;
  readonly onCancelCompile: () => void;
  readonly onCompile: () => void;
  readonly onInsertCitation: () => void;
  readonly onLocatePdf: () => void;
  readonly onSave: () => void;
  readonly onToggleAutoCompile: () => void;
}

export function createWritingCommands(options: WritingCommandOptions): readonly WritingCommand[] {
  return [
    {
      id: "save",
      label: "保存当前文件",
      description: "立即将编辑缓冲写入受管工程",
      disabled: !options.canSave,
      run: options.onSave,
    },
    {
      id: "compile",
      label: "编译 PDF",
      description: "先保存源码，再使用选定的本机 LaTeX engine 编译",
      shortcut: "Cmd/Ctrl+S / Enter",
      disabled: !options.canCompile,
      run: options.onCompile,
    },
    {
      id: "cancel-compile",
      label: "取消当前编译",
      description: "终止正在运行的 LaTeX 编译任务",
      disabled: !options.isCompiling,
      run: options.onCancelCompile,
    },
    {
      id: "insert-citation",
      label: "插入文献引用",
      description: "从当前项目或全部文献中选择引用",
      disabled: !options.canInsertCitation,
      run: options.onInsertCitation,
    },
    {
      id: "locate-pdf",
      label: "在 PDF 中定位",
      description: "用当前成功构建的 SyncTeX 定位光标",
      disabled: !options.canLocatePdf,
      run: options.onLocatePdf,
    },
    {
      id: "toggle-auto-compile",
      label: options.autoCompile ? "关闭自动编译" : "开启自动编译",
      description: "仅在保存成功后触发防抖编译",
      run: options.onToggleAutoCompile,
    },
  ];
}
