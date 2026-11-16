import { decodeAgentContextConfigurationEnvironmentRequest, decodeAgentContextConfigurationSaveIntent, decodeAgentContextConfigurationSeedIntent,
  type AgentContextConfigurationSaveIntent, type AgentContextConfigurationSeedIntent, type AgentContextState } from "@research-assistant/core/agent";
import { createAgentContextConfigurationSaveGateway, createAgentContextConfigurationSeedGateway, type AgentMetadataInvoke } from "@research-assistant/data/agent";
import { flushStorage } from "@research-assistant/workbench-preview/storage-persistence";
import { decodeMockState, encodeMockState } from "@research-assistant/workbench-preview/mock-state-codec";

type Intent = AgentContextConfigurationSaveIntent | AgentContextConfigurationSeedIntent;
type Family = "agent.context.configuration.save" | "agent.context.configuration.seed";
interface Receipt { readonly family: Family; readonly intent: Intent; readonly fence: string }
interface Metadata { readonly epoch: string; fence: number; readonly receipts: Map<string, Receipt> }
type Configurations = Map<string, { revision: number; state: AgentContextState }>;
const metadataKey = "native-context-configuration-receipts";
const configurationsKey = "native-context-configurations";

/** Synthetic authority for the general mock runtime. The designated native
 * Canvas preview uses the production SQL owner instead of this adapter. */
export async function createMockContextConfigurationAuthority(storage: Storage, configurations: Configurations,
  before: () => Promise<void> = async () => undefined, authorize: (conversationId: string) => Promise<void> = async () => undefined) {
  const raw = storage.getItem(metadataKey);
  const metadata: Metadata = raw ? decodeMockState(raw) : { epoch: crypto.randomUUID(), fence: 0, receipts: new Map() };
  if (!(metadata.receipts instanceof Map) || !Number.isSafeInteger(metadata.fence) || metadata.fence < 0) throw new Error("MOCK_CONTEXT_RECEIPTS_INVALID");
  if (!raw) { storage.setItem(metadataKey, encodeMockState(metadata)); await flushStorage(storage); }
  let blocked = false, tail: Promise<void> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run); tail = result.then(() => undefined, () => undefined); return result;
  }
  function receipt(intent: Intent, family: Family): Receipt | undefined {
    const saved = metadata.receipts.get(intent.operationId);
    if (saved && (saved.family !== family || JSON.stringify(saved.intent) !== JSON.stringify(intent))) throw new Error("MOCK_CONTEXT_RECEIPT_CONFLICT");
    return saved;
  }
  function proof(intent: Intent, row: Receipt, replayed: boolean) {
    return { schemaVersion: 1, operationId: intent.operationId, conversationId: intent.conversationId,
      epoch: metadata.epoch, family: row.family, sqlFence: row.fence, replayed, result: null };
  }
  function checkEpoch(intent: Intent): void {
    if (intent.expectedEpoch !== metadata.epoch) throw new Error("MOCK_CONTEXT_EPOCH_MISMATCH");
  }
  async function invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    return serial(async () => {
      await before();
      if (command === "agent_read_context_configuration_environment") {
        if (blocked) throw new Error("MOCK_CONTEXT_RECOVERY_REQUIRED");
        const request = decodeAgentContextConfigurationEnvironmentRequest(args.request);
        return { schemaVersion: 1, ...request, epoch: metadata.epoch, sqlFence: String(metadata.fence),
          configuration: structuredClone(configurations.get(request.conversationId) ?? null) };
      }
      const isSave = command === "agent_save_context_configuration_proven" || command === "agent_read_context_configuration_save_status";
      const isSeed = command === "agent_seed_context_configuration_proven" || command === "agent_read_context_configuration_seed_status";
      if (!isSave && !isSeed) throw new Error("MOCK_CONTEXT_COMMAND_INVALID");
      const intent = isSave ? decodeAgentContextConfigurationSaveIntent(args.request) : decodeAgentContextConfigurationSeedIntent(args.request);
      const family: Family = isSave ? "agent.context.configuration.save" : "agent.context.configuration.seed";
      checkEpoch(intent);
      const row = receipt(intent, family);
      const status = command.includes("_status");
      if (blocked) {
        if (status) return { type: "unconfirmed", epoch: metadata.epoch, sqlFence: String(metadata.fence), blocked: true, closed: false, reason: "mock_storage_unconfirmed" };
        throw new Error("MOCK_CONTEXT_RECOVERY_REQUIRED");
      }
      if (status) return row ? { type: "committed", proof: proof(intent, row, true) }
        : { type: "noSqlReceipt", epoch: metadata.epoch, sqlFence: String(metadata.fence), closed: false };
      await authorize(intent.conversationId);
      if (row) return proof(intent, row, true);
      if (isSave) {
        const save = decodeAgentContextConfigurationSaveIntent(intent);
        if ((configurations.get(save.conversationId)?.revision ?? 0) !== save.expectedRevision) throw "confirmationMismatch";
        configurations.set(save.conversationId, { revision: save.expectedRevision + 1, state: structuredClone(save.state) });
      }
      const next: Receipt = { family, intent: structuredClone(intent), fence: String(++metadata.fence) };
      metadata.receipts.set(intent.operationId, next);
      try {
        // These synchronous changes enter one IndexedDB batch before flushing.
        if (isSave) storage.setItem(configurationsKey, encodeMockState(configurations));
        storage.setItem(metadataKey, encodeMockState(metadata));
        await flushStorage(storage);
      } catch (reason) { blocked = true; throw reason; }
      return proof(intent, next, false);
    });
  }
  const port: AgentMetadataInvoke = invoke;
  return { configurationSave: createAgentContextConfigurationSaveGateway(port), configurationSeed: createAgentContextConfigurationSeedGateway(port) };
}
