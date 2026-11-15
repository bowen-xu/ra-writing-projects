// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {AgentInputDraft} from "@research-assistant/core/agent";
import {WritingAgentPanel} from "../../../../../../apps/web/src/core/features/agent/presentation/WritingAgentPanel";

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

it("shows preparation and running activity while collapsed without hiding draft references",async()=>{
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const changed=vi.fn(),cancel=vi.fn();
  const draft:AgentInputDraft={text:"未发送草稿",bindings:[],evidence:[{type:"annotation",source:"source://notes/note:#block{b}",title:"原文",text:"quote",comment:""}]};
  const access={draft:()=>draft,set:vi.fn()};
  try {
    for(const [isSubmitting,isRunning] of [[false,false],[true,false],[true,true],[false,true],[false,false]] as const) {
      await act(async()=>root.render(<WritingAgentPanel open={false} isSubmitting={isSubmitting} isRunning={isRunning}
        onOpenChange={changed} onCancel={cancel} draft={draft.text} draftResources={access}/>));
      const launcher=host.querySelector<HTMLButtonElement>(".writing-agent-trigger")!,active=isSubmitting||isRunning;
      expect(launcher.getAttribute("aria-busy")).toBe(String(active));
      expect(!!launcher.querySelector(".agent-launcher-spinner")).toBe(active);
      expect(launcher.querySelector(".agent-reference-count-badge")?.textContent).toBe("1");
      expect(launcher.getAttribute("aria-description")).toContain("草稿含 1 项引用");
      if(active) await act(async()=>launcher.click());
    }
    expect(changed).toHaveBeenCalledWith(true);
    expect(cancel).not.toHaveBeenCalled();
  } finally {await act(async()=>root.unmount());host.remove();}
});
