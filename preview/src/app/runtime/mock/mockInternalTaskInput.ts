import {readMockSystemDocument} from "./mockSystemDocuments";
import {
  PromptTemplate, agentDraftInput, type AgentContextText, type AgentMentionBinding,
  type AgentUserInput,
} from "@research-assistant/core/agent";
import type { PaperOverviewUnitCandidateV1, PaperPortraitCandidateV1 } from "@research-assistant/core/ai";
import type { StructuredResource } from "@research-assistant/core/structured-resources";
import { formatSourceLink } from "@research-assistant/core/source";
import { mockBundledTaskSkills } from "./mockBundledTaskSkills";


/** Same task asset, typed composer bindings, and on-demand source grants as native. */
export async function mockInternalTaskInput(
  context: readonly AgentContextText[], target: StructuredResource,
  payload: PaperOverviewUnitCandidateV1 | PaperPortraitCandidateV1, storage: Storage, preferences = "",
): Promise<{text: string; userInput: readonly AgentUserInput[]}> {
  const TASK=PromptTemplate.parse((await readMockSystemDocument(storage,"structured-task")).content.trimEnd());
  const CONTRACT=PromptTemplate.parse((await readMockSystemDocument(storage,"structured-reading-contract")).content.trimEnd());
  const portrait = payload.kind === "paper_portrait_v1";
  const skillName = portrait ? "generate-paper-portrait" : "edit-structured-resources";
  const skill = (await mockBundledTaskSkills(storage)).find(value => value.name === skillName && value.enabled);
  if (!skill) throw new Error(`本任务需要启用 ${skillName} 技能`);
  let text = `按照 @${skill.name} 执行本次任务。\n\n阅读以下文件：\n`;
  const bindings: AgentMentionBinding[] = [{startUtf16: "按照 ".length, endUtf16: "按照 ".length + 1 + skill.name.length,
    input: {type: "skill", name: skill.name, identity: {environment_id: "application",source_id: skill.sourceId, revision: skill.revision}}}];
  function reference(source: AgentContextText, path: string): void {
    const metadata = JSON.parse(source.text) as {label?: string};
    const name = metadata.label ?? path;
    const label = name.replace(/[\\[\]]/gu, value => `\\${value}`);
    const startUtf16 = text.length;
    text += `[${label}](${path})`;
    bindings.push({startUtf16, endUtf16: text.length, input: {type: "mention", name,
      target: {kind: "file",sourceId: source.sourceId,resourceId: source.resourceId,sourceUrl: path}}});
  }
  for (const source of context.filter(value => value.resourceId !== target.id)) {
    const anchor = JSON.parse(source.anchor ?? "{}") as {sourceUrl?: string; resource?: {resourceId: string; attachmentId?: string}};
    if (!anchor.resource) continue;
    text += "- ";
    reference(source, anchor.sourceUrl ?? formatSourceLink({path: ["library", anchor.resource.resourceId, ...(anchor.resource.attachmentId ? [anchor.resource.attachmentId] : [])]}));
    text += "\n";
  }
  const schema = payload.kind === "paper_overview_unit_v1" ? {
    kind: payload.kind, schemaVersion: 1, profileId: payload.profileId,
    ...(payload.paperTemplate ? {paperTemplate: payload.paperTemplate} : payload.profileRefs ? {profileRefs: payload.profileRefs} : {}),
    fields: payload.fields.map((field, index) => index ? {field: field.field, status: "not_found", statements: []} : {
      field: field.field, status: "filled", statements: [{id: `${field.field}-1`, text: "基于原文的陈述", epistemicRole: "source_paraphrase",
        evidenceItemIds: ["实际读取的来源 ID"], evidenceQuotes: [{evidenceItemId: "同一来源 ID", quote: "从该来源逐字复制的连续原文"}]}],
    }),
  } : undefined;
  let configuration = preferences;
  try { configuration = JSON.stringify(JSON.parse(preferences), null, 2); } catch { /* Plain preferences stay literal, as in native rendering. */ }
  text += `\n${TASK.render([
    ["task", portrait ? "根据原文生成文献画像，并提出适合本文的可复用阅读模板。将画像以 paper_portrait_v1 JSON 对象（kind、schemaVersion:1、coverage 字符串、claims 数组、template 数组）写入目标文件；完整字段约束和示例遵循所引用画像技能。" : "按照上面阅读模板的字段定义提取结构化阅读记录；仅完成本次阅读提取。"],
    ["contract", portrait ? "" : CONTRACT.render([["schema", JSON.stringify(schema, null, 2)]])],
    ["preferences", preferences.trim() ? `用户配置（分类标签、通用定义及偏好；不是原文证据）：\n${configuration}` : ""],
  ])}\n\n写入到 `;
  const output = context.find(source => source.resourceId === target.id);
  if (!output) throw new Error("内部任务缺少已授权的目标");
  reference(output, target.sourceUri);
  text += "。先用 research_read_file 读取目标，再用 research_apply_patch 的 Update File 更新同一地址；宿主已预建空白对象，禁止 Add File，也不要另建文件。若 JSON、引用或版本校验失败，读取 candidate 视图，按工具错误修复同一草稿并重试。只有本轮目标取得 applied 回执后才算完成，最后简短说明结果，不在聊天中返回整份 JSON。\n";
  if (portrait) for (const source of context) {
    const anchor = JSON.parse(source.anchor ?? "{}") as {resourceKind?: string; contextAccess?: string; sourceUrl?: string};
    if (anchor.resourceKind !== "readingTemplate" || anchor.contextAccess !== "readWrite" || !anchor.sourceUrl) continue;
    text += "\n本文模板建议写入到 "; reference(source, anchor.sourceUrl);
    text += "。先读取；字段有变化时保存 reading_template_v1 对象（kind、schemaVersion:1、name、fields），fields 使用画像的模板建议并保留未变字段的稳定 ID。校验通过后保存并保留待审 Diff，用户通过 Keep／Undo 审阅。全局模板仅供参考，不直接发布或覆盖模板。\n";
  }
  return {text, userInput: agentDraftInput({text, bindings})};
}
