// @vitest-environment happy-dom
import { act as reactAct, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readCompilePreferences } from "../compilePreferences";
import { CompileOptionsMenu } from "./CompileOptionsMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });

it("updates checked compile settings, closes after selection, and exposes real compile actions", async () => {
  const cancel = vi.fn(); const scratch = vi.fn();
  function Harness({ running }: { running: boolean }) {
    const [preferences, setPreferences] = useState(() => readCompilePreferences(undefined));
    const [auto, setAuto] = useState(false);
    return <CompileOptionsMenu autoCompile={auto} onAutoCompileChange={setAuto} preferences={preferences} onPreferencesChange={setPreferences} available isCompiling={running} onCancel={cancel} onFromScratch={scratch} />;
  }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness running={false} />));
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!;
  const groupButton = (group: string, text: string) => Array.from(
    [...document.querySelectorAll<HTMLElement>('[role="group"]')]
      .find((candidate) => candidate.getAttribute("aria-label") === group)!
      .querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent === text)!;
  for (const [group, label] of [["自动编译", "开启"], ["编译模式", "快速（草稿）"], ["Code Check", "关闭"], ["编译错误处理", "遇到第一个错误时停止"]] as const) {
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
    await act(async () => groupButton(group, label).click());
    expect(groupButton(group, label).getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe("false");
  }
  expect(button("停止编译").disabled).toBe(true);
  await act(async () => button("从头重新编译").click());
  expect(scratch).toHaveBeenCalledOnce();
  await act(async () => root.render(<Harness running />));
  expect(button("从头重新编译").disabled).toBe(true);
  await act(async () => button("停止编译").click());
  expect(cancel).toHaveBeenCalledOnce();
});

it("restores compile preferences with safe defaults for older sessions", () => {
  expect(readCompilePreferences(undefined)).toEqual({ draft: false, codeCheck: true, stopOnFirstError: false });
  expect(readCompilePreferences({ draft: true, checkSyntax: false, stopOnFirstError: true })).toEqual({ draft: true, codeCheck: false, stopOnFirstError: true });
  expect(readCompilePreferences({ codeCheck: true, checkSyntax: false })).toEqual({ draft: false, codeCheck: true, stopOnFirstError: false });
});

async function act(callback: () => unknown): Promise<void> {
  await reactAct(async () => { await callback(); });
  await reactAct(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
}
