import { WritingMenuItem } from "../WritingMenu";
import { Check, ChevronDown } from "lucide-react";
import type { CompilePreferences } from "../compilePreferences";
import { PreviewMenu } from "./PreviewMenu";

interface Props {
  readonly autoCompile: boolean;
  readonly onAutoCompileChange: (value: boolean) => void;
  readonly preferences: CompilePreferences;
  readonly onPreferencesChange: (value: CompilePreferences) => void;
  readonly isCompiling: boolean;
  readonly available: boolean;
  readonly onCancel: () => void;
  readonly onFromScratch: () => void;
}

export function CompileOptionsMenu(props: Props): React.JSX.Element {
  function choice(label: string, checked: boolean, action: () => void): React.JSX.Element {
    return <WritingMenuItem type="button" role="menuitemradio" aria-checked={checked} onClick={action}><span>{label}</span>{checked && <Check size={16} />}</WritingMenuItem>;
  }
  const change = (key: keyof CompilePreferences, value: boolean): void => props.onPreferencesChange({ ...props.preferences, [key]: value });
  return <PreviewMenu label="编译选项" className="compile-options" trigger={<ChevronDown size={15} />}>
    <div className="writing-compile-options">
      <div role="group" aria-label="自动编译"><span>自动编译</span>
        {choice("开启", props.autoCompile, () => props.onAutoCompileChange(true))}
        {choice("关闭", !props.autoCompile, () => props.onAutoCompileChange(false))}
      </div>
      <div role="group" aria-label="编译模式"><span>编译模式</span>
        {choice("正常", !props.preferences.draft, () => change("draft", false))}
        {choice("快速（草稿）", props.preferences.draft, () => change("draft", true))}
      </div>
      <div role="group" aria-label="Code Check"><span>Code Check</span>
        {choice("开启", props.preferences.codeCheck, () => change("codeCheck", true))}
        {choice("关闭", !props.preferences.codeCheck, () => change("codeCheck", false))}
        <small>输入时检查 LaTeX 结构；发现问题时暂停自动编译。</small>
      </div>
      <div role="group" aria-label="编译错误处理"><span>编译错误处理</span>
        {choice("遇到第一个错误时停止", props.preferences.stopOnFirstError, () => change("stopOnFirstError", true))}
        {choice("遇到错误仍尝试编译", !props.preferences.stopOnFirstError, () => change("stopOnFirstError", false))}
      </div>
      <div role="group" aria-label="编译操作">
        <WritingMenuItem type="button" role="menuitem" disabled={!props.isCompiling} onClick={props.onCancel}>停止编译</WritingMenuItem>
        <WritingMenuItem type="button" role="menuitem" disabled={props.isCompiling || !props.available} onClick={props.onFromScratch}>从头重新编译</WritingMenuItem>
      </div>
    </div>
  </PreviewMenu>;
}
