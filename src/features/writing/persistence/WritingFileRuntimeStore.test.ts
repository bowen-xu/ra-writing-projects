import {expect, it, vi} from "vitest";
import {WritingFileRuntimeStore, type WritingFileApplications} from "./WritingFileRuntimeStore";

it("queries every original project owner live instead of treating flush or a React snapshot as idle", async () => {
  type Dependencies = ConstructorParameters<typeof WritingFileRuntimeStore>;
  const owner = new WritingFileRuntimeStore({} as Dependencies[0], {} as Dependencies[1], {} as Dependencies[2], {} as Dependencies[3]);
  expect(owner.hasPendingDeliveries()).toBe(false);
  owner.activate("hidden"); expect(owner.hasPendingDeliveries()).toBe(true);
  let pending = false;
  const flush = vi.fn(async () => undefined), query = vi.fn(() => pending);
  owner.setApplications("hidden", {agentDelivery: {pending: false, hasPending: query, flush}} as unknown as WritingFileApplications);
  expect(owner.hasPendingDeliveries()).toBe(false);
  pending = true;
  expect(owner.hasPendingDeliveries()).toBe(true);
  await owner.flushDeliveries(); expect(owner.hasPendingDeliveries()).toBe(true);
  expect(flush).toHaveBeenCalledOnce(); expect(owner.getApplications("hidden")?.agentDelivery.pending).toBe(false);
  pending = false; expect(owner.hasPendingDeliveries()).toBe(false);
  owner.activate("unvisited"); expect(owner.hasPendingDeliveries()).toBe(true);
  owner.setApplications("unvisited", {agentDelivery: {hasPending: () => false}} as unknown as WritingFileApplications);
  expect(owner.hasPendingDeliveries()).toBe(false);
});
