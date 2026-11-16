import {lazyMockSystemDocuments} from "../../runtime/mock/mockSystemDocuments";
import {getAppStorage} from "@research-assistant/workbench-preview/app-storage";
import type { AgentResourceGateways } from "@research-assistant/workbench-preview/agent-resource-gateways";
import { mockBundledTaskSkills, readMockBundledTaskSkill } from "../../runtime/mock/mockBundledTaskSkills";
import type {AgentSkillCatalogGateway} from "@research-assistant/data/agent";
import type {agentMcpGateway} from "@research-assistant/workbench-preview/agent-gateway";

type ManagedMockResources = AgentResourceGateways & {readonly skills: AgentSkillCatalogGateway; readonly tools: typeof agentMcpGateway};

/** Only resource metadata and I/O are mocked; menus use production controls. */
export function createMockAgentResourceGateways(storage?: Storage): ManagedMockResources {
  const saved = JSON.parse(storage?.getItem("agent-resources") ?? "null") as { approved: boolean; enabled: boolean; revision: number } | null;
  let approved = saved?.approved ?? false;
  let enabled = saved?.enabled ?? true;
  let revision = saved?.revision ?? 1;
  const persist = () => storage?.setItem("agent-resources", JSON.stringify({ approved, enabled, revision }));
  const mockServers = (): string[] => [...(storage?.getItem("mcp-config") ?? "").matchAll(/^\[servers\.("(?:[^"\\]|\\.)*")\]/gm)].flatMap(match => { try { return [JSON.parse(match[1]!) as string]; } catch { return []; } });
  const approvedIds = (): string[] => JSON.parse(storage?.getItem("mcp-approved") ?? "[]") as string[];
  const catalog: AgentSkillCatalogGateway["list"] = async () => ({
    schemaVersion: 1, environmentId: "application", errors: [],
    skills: [{ sourceId: "mock/academic-writing/SKILL.md", name: "模拟写作技能", description: "仅用于预览交互，不调用真实模型", revision: String(revision), allowImplicitInvocation: true, enabled }, ...await mockBundledTaskSkills(storage)],
  });
  return {
    systemDocuments: lazyMockSystemDocuments(() => storage ?? getAppStorage()),
    readSkillDocument: async (identity) => {
      const bundled = await readMockBundledTaskSkill(identity,storage);
      if (bundled !== undefined) return bundled;
      if (identity.environment_id !== "application" || identity.source_id !== "mock/academic-writing/SKILL.md" || identity.revision !== String(revision)) throw new Error("模拟技能版本已变化，请重新选择");
      return "# 模拟写作技能\n\n整理摘要、核对论证并保留来源。\n\n此说明由模拟网关返回，不读取本机文件。";
    },
    tools: {
      list: async () => [{ serverId: "模拟文献检索", environmentId: "mock", revision: "1", enabled: true, credentialConfigured: true, approved }, ...mockServers().map(serverId => ({ serverId, environmentId: "mock", revision: "1", enabled: true, credentialConfigured: true, approved: approvedIds().includes(serverId) }))],
      install: async (ids) => { approved = ids.includes("模拟文献检索"); storage?.setItem("mcp-approved", JSON.stringify(ids)); persist(); },
      revoke: async (id) => { if (id === "模拟文献检索") approved = false; storage?.setItem("mcp-approved", JSON.stringify(approvedIds().filter(value => value !== id))); persist(); },
    },
    skills: {
      list: catalog,
      setEnabled: async (sourceId, expectedRevision, nextEnabled) => {
        const bundled = (await mockBundledTaskSkills(storage)).find(value => value.sourceId === sourceId);
        if (bundled) {
          if (expectedRevision !== bundled.revision) throw new Error("技能版本已变化");
          storage?.setItem(`mock-task-skill:${bundled.name}`, nextEnabled ? "enabled" : "disabled");
          return catalog();
        }
        if (sourceId !== "mock/academic-writing/SKILL.md" || expectedRevision !== String(revision)) throw new Error("模拟技能版本已变化，请重新打开菜单");
        enabled = nextEnabled;
        revision += 1;
        persist();
        return catalog();
      },
    },
  };
}
