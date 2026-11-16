import { afterEach, expect, it, vi } from "vitest";
import type { AgentMetadataGateway } from "@research-assistant/data/agent";
import type { WritingAgentRuntimeGateways } from "../../src/features/writing/agent/writingRuntimeGateways";
import { WritingDemoMetadataState } from "./WritingDemoMetadataState";
import { WritingDemoSubmissionStates } from "./WritingDemoSubmissionStates";

afterEach(() => vi.useRealTimers());

it("automatically resumes normal metadata checking at the selected delay and supports rescheduling", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue({ title: "mock" });
  const state = new WritingDemoMetadataState({read} as unknown as AgentMetadataGateway, false, 1000);
  const result = state.gateway.read({} as Parameters<AgentMetadataGateway["read"]>[0]);
  await vi.advanceTimersByTimeAsync(500);
  expect(read).not.toHaveBeenCalled();
  state.setDuration(200);
  await vi.advanceTimersByTimeAsync(199);
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual({title: "mock"});
  state.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("allows manual continuation and does not auto-release an injected metadata failure", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue({ title: "mock" });
  const state = new WritingDemoMetadataState({read} as unknown as AgentMetadataGateway, true, 1000);
  const result = state.gateway.read({} as Parameters<AgentMetadataGateway["read"]>[0]);
  const rejection = expect(result).rejects.toThrow("模拟会话状态核对失败");
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).not.toHaveBeenCalled();
  state.continue();
  await rejection;
  await expect(state.gateway.read({} as Parameters<AgentMetadataGateway["read"]>[0])).resolves.toEqual({title: "mock"});
  state.dispose();
});

it("automatically resumes normal submission preparation and clears timers on disposal", async () => {
  vi.useFakeTimers();
  const prepareWriting = vi.fn().mockResolvedValue({requestId:"request"});
  const base = {submission:{prepareWriting}} as unknown as WritingAgentRuntimeGateways;
  const state = new WritingDemoSubmissionStates(base, "submissionPreparing", 1000);
  const request = {requestId:"request"} as Parameters<typeof prepareWriting>[0];
  const result = state.gateways.submission.prepareWriting(request);
  await vi.advanceTimersByTimeAsync(999);
  expect(prepareWriting).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual({requestId:"request"});
  const abandoned = state.gateways.submission.prepareWriting({...request,requestId:"next"});
  const rejected = expect(abandoned).rejects.toThrow("模拟发送场景已关闭");
  state.dispose();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps an injected preparation failure waiting until explicitly continued", async () => {
  vi.useFakeTimers();
  const prepareWriting = vi.fn().mockResolvedValue({requestId:"request"});
  const state = new WritingDemoSubmissionStates({submission:{prepareWriting}} as unknown as WritingAgentRuntimeGateways, "submissionCheckingFailed", 1000);
  const result = state.gateways.submission.prepareWriting({requestId:"request"} as Parameters<typeof prepareWriting>[0]);
  const rejection = expect(result).rejects.toThrow("模拟发送失败");
  state.setDuration(5);
  await vi.advanceTimersByTimeAsync(5000);
  expect(prepareWriting).not.toHaveBeenCalled();
  state.continue();
  await rejection;
  state.dispose();
});
