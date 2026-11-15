// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManuscriptPath, type Manuscript } from "@research-assistant/writing";

import { ManuscriptLibrary } from "./ManuscriptLibrary";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const archived: Manuscript = {
  id: "archived", title: "旧稿件", status: "archived", rootPath: parseManuscriptPath("main.tex"),
  createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z",
};

describe("manuscript archive navigation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof ManuscriptLibrary>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    props = { manuscripts: [archived], isLoading: false, onOpen: vi.fn(), onCreate: vi.fn(), onStatusChange: vi.fn(), onDelete: vi.fn(), transferActions: null };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("opens archived manuscripts from their category and restores them without copying", async () => {
    await act(async () => root.render(<ManuscriptLibrary {...props} />));
    const category = host.querySelectorAll<HTMLButtonElement>("aside button")[1];
    await act(async () => { category?.click(); });
    expect(host.querySelector(".writing-project-link")?.textContent).toBe(archived.title);
    await act(async () => { host.querySelector<HTMLButtonElement>(".writing-project-link")?.click(); });
    expect(props.onOpen).toHaveBeenCalledWith(archived.id);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="稿件操作 旧稿件"]')?.click(); });
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent?.includes("恢复归档"))?.click(); });
    expect(props.onStatusChange).toHaveBeenCalledWith(archived);
    await act(async () => root.render(<ManuscriptLibrary {...props} manuscripts={[{ ...archived, status: "active" }]} />));
    expect(host.querySelector(".writing-project-link")).toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>("aside button")?.click(); });
    expect(host.querySelector(".writing-project-link")?.textContent).toContain(archived.title);
  });

  it("cycles both sortable headers back to the default recent-first order", async () => {
    const manuscripts: Manuscript[] = [
      { ...archived, id: "older", title: "Alpha", status: "active" },
      { ...archived, id: "newer", title: "Beta", status: "active", updatedAt: "2026-09-07T00:00:00Z" },
    ];
    await act(async () => root.render(<ManuscriptLibrary {...props} manuscripts={manuscripts} />));
    const order = (): string[] => [...host.querySelectorAll(".writing-project-link span")].map((node) => node.firstChild?.textContent ?? "");
    expect(order()).toEqual(["Beta", "Alpha"]);
    for (const header of host.querySelectorAll("th[aria-sort]")) {
      const button = header.querySelector<HTMLButtonElement>("button");
      for (const state of ["ascending", "descending", "none"]) {
        await act(async () => { button?.click(); });
        expect(header.getAttribute("aria-sort")).toBe(state);
        expect(order()).toEqual(state === "ascending" ? ["Alpha", "Beta"] : ["Beta", "Alpha"]);
        expect(header.querySelector("svg") === null).toBe(state === "none");
      }
    }
    const headers = host.querySelectorAll("th[aria-sort]");
    await act(async () => { headers[0]?.querySelector<HTMLButtonElement>("button")?.click(); });
    await act(async () => { headers[1]?.querySelector<HTMLButtonElement>("button")?.click(); });
    expect(headers[0]?.getAttribute("aria-sort")).toBe("none");
    expect(headers[1]?.getAttribute("aria-sort")).toBe("ascending");
  });
});
