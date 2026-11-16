import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { AppToaster } from "@research-assistant/workbench-preview/app-toaster";
import { BoundConversationList } from "@research-assistant/workbench-preview/bound-conversation-list";
import { conversationDeletePreviewBinding, conversationDeleteScenarios, createConversationDeletePreviewData, type ConversationDeleteScenario } from "./conversationDeletePreviewData";
import "../../../../../src/features/writing/WritingWorkspace.css";
import "../../../../../src/features/writing/WritingWorkbench.css";
import "../../../../styles/ConversationDeleteDemo.css";

export function ConversationDeleteDemo(): React.JSX.Element {
  const [scenario, setScenario] = useState<ConversationDeleteScenario>("success");
  const [generation, setGeneration] = useState(0);
  return <main className="conversation-delete-demo">
    <header className="conversation-delete-demo-header">
      <h1>归档对话 · 删除预览</h1>
      <p>悬停对话行，点击右侧垃圾桶，或右键选择“永久删除对话”。</p>
    </header>
    <div className="conversation-delete-demo-controls">
      <label>Mock 场景 <select value={scenario} onChange={(event) => {
        const next = conversationDeleteScenarios.find((item) => item.id === event.target.value);
        if (next) setScenario(next.id);
      }}>{conversationDeleteScenarios.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <button type="button" onClick={() => setGeneration((value) => value + 1)}><RotateCcw aria-hidden="true" size={16} />重置 mock 数据</button>
    </div>
    <p className="conversation-delete-demo-scenario">{conversationDeleteScenarios.find((item) => item.id === scenario)?.description}</p>
    <ConversationDeletePreview key={`${scenario}:${generation}`} scenario={scenario} />
    <footer className="conversation-delete-demo-footer">复用实际对话列表、删除弹窗和通知。数据、删除、下载及“今日不再提示”均为内存模拟；刷新或重置后恢复，不操作真实对话。</footer>
    <AppToaster />
  </main>;
}

function ConversationDeletePreview({ scenario }: { readonly scenario: ConversationDeleteScenario }): React.JSX.Element {
  const [data] = useState(() => createConversationDeletePreviewData(scenario));
  const [selectedId, setSelectedId] = useState<string | null>(data.firstConversation.id);
  return <div className="conversation-delete-demo-frame">
    <div className="writing-workspace">
      <BoundConversationList binding={conversationDeletePreviewBinding} selectedId={selectedId}
        revealConversation={data.firstConversation} onSelect={setSelectedId}
        onDeleted={(id) => setSelectedId((current) => current === id ? null : current)}
        catalog={data.catalog} archives={data.archives} metadata={data.metadata} search={data.search}
        deletions={data.deletions} exports={data.exports} deletionConfirmationPreferences={data.deletionConfirmationPreferences}
        deletionRecoveryStorage={data.recoveryStorage}
        forceDeletionConfirmationPreferences={data.forceDeletionConfirmationPreferences} />
    </div>
  </div>;
}
