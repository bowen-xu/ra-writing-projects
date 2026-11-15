import { copyLineDown, indentMore } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { EditorSelection, type StateCommand } from "@codemirror/state";

/** Indent selected lines; an empty selection inserts indentation at the cursor. */
export function insertWritingIndent(target: Parameters<StateCommand>[0]): boolean {
  const { state, dispatch } = target;
  if (state.readOnly) return true;
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(target);
  dispatch(state.update(state.replaceSelection(state.facet(indentUnit)), {
    scrollIntoView: true,
    userEvent: "input.type",
  }));
  return true;
}

export function duplicateWritingSelection(target: Parameters<StateCommand>[0]): boolean {
  const { state, dispatch } = target;
  if (state.readOnly) return true;
  if (state.selection.ranges.every((range) => range.empty)) return copyLineDown(target);
  dispatch(state.update(state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.to, insert: text },
      range: EditorSelection.range(range.to, range.to + text.length),
    };
  }), { scrollIntoView: true, userEvent: "input.copy" }));
  return true;
}

function hasBalancedGroups(text: string): boolean {
  let depth = 0;
  let inComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n") inComment = false;
    if (inComment) continue;
    if (character === "\\") index += 1;
    else if (character === "%") inComment = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth < 0) return false;
  }
  return depth === 0 && !inComment;
}

export function changeWritingCase(mode: "upper" | "lower"): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return true;
    dispatch(state.update(state.changeByRange((range) => {
      const original = state.sliceDoc(range.from, range.to);
      const text = mode === "upper" ? original.toUpperCase() : original.toLowerCase();
      return {
        changes: { from: range.from, to: range.to, insert: text },
        range: EditorSelection.range(range.from, range.from + text.length),
      };
    }), { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

/** Wrap the selection, or remove the same wrapper immediately around it. */
export function toggleWritingStyle(command: "textbf" | "textit"): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return true;
    const prefix = `\\${command}{`;
    dispatch(state.update(state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      const isWrapped = range.from >= prefix.length
        && state.sliceDoc(range.from - prefix.length, range.from) === prefix
        && state.sliceDoc(range.to, range.to + 1) === "}"
        && hasBalancedGroups(selected);
      if (isWrapped) {
        return {
          changes: [
            { from: range.from - prefix.length, to: range.from },
            { from: range.to, to: range.to + 1 },
          ],
          range: EditorSelection.range(range.from - prefix.length, range.to - prefix.length),
        };
      }
      return {
        changes: { from: range.from, to: range.to, insert: `${prefix}${selected}}` },
        range: EditorSelection.range(range.from + prefix.length, range.to + prefix.length),
      };
    }), { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}
