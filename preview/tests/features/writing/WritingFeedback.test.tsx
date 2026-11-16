// @vitest-environment happy-dom
import {act,StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
vi.mock("@research-assistant/workbench-preview/notifications",()=>({notify:{warning:vi.fn(),info:vi.fn(),dismiss:vi.fn()}}));
import {notify} from "@research-assistant/workbench-preview/feedback";
import {WritingFeedback} from "@research-assistant/writing-projects-preview/writing-feedback";
it("projects citation notices through the shared notification component without custom warning UI",async()=>{
 const host=document.createElement("div"),root=createRoot(host);
 const props={manuscriptId:"m",bibliographyStatus:undefined,citationUsage:{usedKeys:[],unusedKeys:[],missingKeys:["missing2026"]},pendingRecovery:undefined,onDiscardRecovery:vi.fn(),onResolveBibliography:vi.fn(),onRestoreRecovery:vi.fn()};
 await act(async()=>root.render(<StrictMode><WritingFeedback {...props}/></StrictMode>));
 expect(host.textContent).toBe("");expect(host.querySelector("[role=alert]")).toBeNull();expect(notify.warning).toHaveBeenCalledWith("缺失引用：missing2026",{id:"writing-citations-missing:m"});
 vi.mocked(notify.warning).mockClear();await act(async()=>root.render(<StrictMode><WritingFeedback {...props}/></StrictMode>));expect(notify.warning).not.toHaveBeenCalled();
 await act(async()=>root.unmount());
});
it("does not notify when deleting a citation leaves an unused bibliography record",async()=>{
 const host=document.createElement("div"),root=createRoot(host);vi.mocked(notify.info).mockClear();
 await act(async()=>root.render(<WritingFeedback manuscriptId="m" bibliographyStatus={undefined}
 citationUsage={{usedKeys:[],unusedKeys:["unused2026"],missingKeys:[]}} pendingRecovery={undefined}
 onDiscardRecovery={vi.fn()} onResolveBibliography={vi.fn()} onRestoreRecovery={vi.fn()}/>));
 expect(notify.info).not.toHaveBeenCalled();expect(host.textContent).toBe("");
 await act(async()=>root.unmount());
});
