import {previewSkillSources} from "@research-assistant/workbench-preview/preview-assets";
const {portrait, editing} = previewSkillSources;
import {readMockSystemDocument} from "./mockSystemDocuments";
import {hashPreviewBytes as writingDiffDemoHash} from "@research-assistant/workbench-preview/preview-assets";
import type { AgentSkillIdentity } from "@research-assistant/core/agent";

const DOCUMENTS: Readonly<Record<string, string>> = {
  "generate-paper-portrait": portrait,
  "edit-structured-resources": editing,
};

/** Embedded skill bytes are real; only the application catalog I/O is mocked. */
export async function mockBundledTaskSkills(storage?: Storage) {
  return Promise.all(Object.entries(DOCUMENTS).map(async ([name, original]) => {
    const contents=storage ? (await readMockSystemDocument(storage,name)).content : original;
    return ({
    name, sourceId: `.agents/skills/${name}/SKILL.md`, revision: await writingDiffDemoHash(contents),
    description: name === "generate-paper-portrait" ? "依据来源生成文献画像与本文阅读模板建议" : "读取、更新和修复结构化阅读资源",
    enabled: storage?.getItem(`mock-task-skill:${name}`) !== "disabled", allowImplicitInvocation: true,
  });}));
}

export async function readMockBundledTaskSkill(identity: AgentSkillIdentity, storage?:Storage): Promise<string | undefined> {
  const descriptor = (await mockBundledTaskSkills(storage)).find(value => value.sourceId === identity.source_id);
  if (!descriptor) return undefined;
  if (identity.environment_id !== "application" || identity.revision !== descriptor.revision) throw new Error("技能版本已变化");
  return storage ? (await readMockSystemDocument(storage,descriptor.name)).content : DOCUMENTS[descriptor.name];
}
