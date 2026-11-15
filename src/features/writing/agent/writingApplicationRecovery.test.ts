import { expect, it, vi } from "vitest";
import { createAgentApplicationGateway } from "@research-assistant/data/agent";
import type { AgentApplicationState, AgentWorkspaceBuffer } from "@research-assistant/core/agent";
import { recoverWritingApplication } from "./writingApplicationRecovery";

function fixture() {
  const scope = {conversationId:crypto.randomUUID(),manuscriptId:crypto.randomUUID(),proposalId:crypto.randomUUID(),operationId:crypto.randomUUID()};
  const state: AgentApplicationState = {kind:"state",schemaVersion:1,scope,status:"recoveryRequired",
    files:[{path:"main.tex",phase:"dispatched",target:{kind:"disk"}}]};
  const confirmed: AgentApplicationState = {...state,status:"applied",files:[{...state.files[0]!,phase:"acknowledged"}]};
  const invoke = vi.fn().mockResolvedValueOnce(state).mockResolvedValue(confirmed);
  const gateway = createAgentApplicationGateway(invoke);
  const lease = {buffers:[] as AgentWorkspaceBuffer[],isCurrent:vi.fn(() => true),refresh:vi.fn(async () => {}),release:vi.fn()};
  const acquire = vi.fn(async () => lease);
  const editor = {apply:vi.fn(),recover:vi.fn()};
  const run = () => recoverWritingApplication(scope,"main.tex",gateway,editor,acquire);
  return {scope,state,confirmed,invoke,lease,editor,run};
}

it("reconciles disk results with the existing identity and releases only after refresh", async () => {
  const f = fixture();
  let finish!: () => void;
  f.lease.refresh.mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  const result = f.run();
  await vi.waitFor(() => expect(f.lease.refresh).toHaveBeenCalled());
  expect(f.lease.release).not.toHaveBeenCalled();
  expect(f.invoke.mock.calls.map(call => call[1].request.action)).toEqual(["read","reconcileDisk"]);
  expect(f.invoke.mock.calls[1]?.[1].request.scope).toEqual(f.scope);
  expect(f.editor.apply).not.toHaveBeenCalled(); expect(f.editor.recover).not.toHaveBeenCalled();
  finish(); expect(await result).toEqual({kind:"state",state:f.confirmed});
  expect(f.lease.release).toHaveBeenCalledTimes(1);
});

it("does not reconcile an open disk target or a changed host", async () => {
  for (const kind of ["open", "stale"]) {
    const f = fixture();
    if (kind === "open") f.lease.buffers.push({path:"main.tex",text:"draft",expectedDiskSha256:"a".repeat(64),sessionId:crypto.randomUUID(),revision:crypto.randomUUID()});
    else f.lease.isCurrent.mockReturnValue(false);
    expect(await f.run()).toEqual({kind:"unavailable"});
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.lease.release).toHaveBeenCalledTimes(1);
  }
});

it("uses only the editor receipt route for editor targets", async () => {
  const f = fixture();
  const state: AgentApplicationState = {...f.state,files:[{path:"main.tex",phase:"dispatched",target:{kind:"editor",sessionId:crypto.randomUUID(),revision:crypto.randomUUID(),resultRevision:null}}]};
  f.invoke.mockReset().mockResolvedValue(state);
  f.editor.recover.mockResolvedValue({kind:"unconfirmed",state});
  expect(await f.run()).toEqual({kind:"unconfirmed",state});
  expect(f.editor.recover).toHaveBeenCalledWith(f.scope,"main.tex");
  expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.editor.apply).not.toHaveBeenCalled();
});

it("reports failed reconciliation or cache refresh as unconfirmed without retrying", async () => {
  for (const failure of ["native","refresh"]) {
    const f = fixture();
    if (failure === "native") f.invoke.mockReset().mockResolvedValueOnce(f.state).mockRejectedValueOnce(new Error("uncertain"));
    else f.lease.refresh.mockRejectedValueOnce(new Error("metadata unavailable"));
    const result = await f.run();
    expect(result.kind).toBe("unconfirmed"); expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.lease.release).toHaveBeenCalledTimes(1);
  }
});
