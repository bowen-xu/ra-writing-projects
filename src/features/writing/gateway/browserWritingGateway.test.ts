import { describe, expect, it } from "vitest";
import { parseManuscriptPath } from "@research-assistant/writing";

import { browserWritingGateway } from "./browserWritingGateway";

describe("browser writing gateway", () => {
  it("keeps archived manuscripts discoverable and restores their source and session", async () => {
    const manuscript = await browserWritingGateway.createManuscript({ title: "归档与恢复" });
    const file = await browserWritingGateway.createFile(manuscript.id, "section.tex", "保留的源码");
    await browserWritingGateway.saveSession({
      manuscriptId: manuscript.id, openPaths: [file.relativePath], activePath: file.relativePath,
      cursorState: { [file.relativePath]: 3 }, layoutState: {},
    });
    const session = await browserWritingGateway.getSession(manuscript.id);
    const archived = await browserWritingGateway.archiveManuscript(manuscript.id);
    expect(await browserWritingGateway.listManuscripts()).toContainEqual(archived);
    expect(await browserWritingGateway.readFile(manuscript.id, file.relativePath)).toEqual(file);
    const restored = await browserWritingGateway.restoreManuscript(manuscript.id);
    expect(restored).toMatchObject({ id: manuscript.id, status: "active", title: manuscript.title });
    expect(await browserWritingGateway.readFile(manuscript.id, file.relativePath)).toEqual(file);
    expect(await browserWritingGateway.getSession(manuscript.id)).toEqual(session);
    await expect(browserWritingGateway.restoreManuscript("missing")).rejects.toThrow("不存在");
  });

  it("supports the editor workflow without pretending to compile", async () => {
    const manuscript = await browserWritingGateway.createManuscript({
      title: "中文写作测试",
    });
    expect(await browserWritingGateway.listManuscripts()).toContainEqual(manuscript);
    const files = await browserWritingGateway.listFiles(manuscript.id);
    const root = await browserWritingGateway.readFile(manuscript.id, manuscript.rootPath);

    expect(browserWritingGateway.supportsCompilation).toBe(false);
    expect(files.map((file) => file.relativePath)).toEqual(["main.tex"]);
    expect(root.content).toContain("\\title{中文写作测试}");

    const saved = await browserWritingGateway.saveFile({
      manuscriptId: manuscript.id,
      relativePath: manuscript.rootPath,
      content: `${root.content}\n% 已保存`,
      expectedSha256: root.sha256,
    });
    expect(saved.sha256).not.toBe(root.sha256);
    await expect(browserWritingGateway.saveFile({
      manuscriptId: manuscript.id,
      relativePath: manuscript.rootPath,
      content: "stale",
      expectedSha256: root.sha256,
    })).rejects.toThrow("重新载入");

    await browserWritingGateway.createDirectory(manuscript.id, "sections");
    await browserWritingGateway.createFile(manuscript.id, "sections/method.tex", "Recovered content");
    expect((await browserWritingGateway.readFile(manuscript.id, "sections/method.tex")).content).toBe("Recovered content");
    expect((await browserWritingGateway.listDirectories(manuscript.id)).map((item) => item.relativePath)).toEqual(["sections"]);
    await browserWritingGateway.renameDirectory(manuscript.id, "sections", "chapters");
    expect((await browserWritingGateway.listFiles(manuscript.id)).map((file) => file.relativePath).sort()).toEqual([
      "chapters/method.tex",
      "main.tex",
    ]);
    await browserWritingGateway.deleteDirectory(manuscript.id, "chapters");
    expect((await browserWritingGateway.listFiles(manuscript.id)).map((file) => file.relativePath)).toEqual(["main.tex"]);
    await expect(browserWritingGateway.importResources(manuscript.id, "figures", ["/tmp/plot.png"]))
      .rejects.toThrow("Tauri");
  });
});

it("permanently deletes only archived manuscript data", async () => {
  const gateway = browserWritingGateway;
  const target = await gateway.createManuscript({ title: "删除测试" });
  const retained = await gateway.createManuscript({ title: "保留测试" });
  await expect(gateway.deleteManuscript(target.id)).rejects.toThrow("先归档");
  await gateway.saveSession({ manuscriptId: target.id, openPaths: [], cursorState: {}, layoutState: {} });
  await gateway.saveRecoveryDraft({ manuscriptId: target.id, relativePath: target.rootPath, content: "draft", baseSha256: "a".repeat(64) });
  await gateway.archiveManuscript(target.id);
  await gateway.deleteManuscript(target.id);
  expect((await gateway.listManuscripts()).some((item) => item.id === target.id)).toBe(false);
  expect((await gateway.listManuscripts()).some((item) => item.id === retained.id)).toBe(true);
  expect(await gateway.getSession(target.id)).toBeUndefined();
  expect(await gateway.listRecoveryDrafts(target.id)).toEqual([]);
  await expect(gateway.readFile(target.id, target.rootPath)).rejects.toThrow();
});

it("protects every bibliography path and containing directories from raw mutations", async () => {
  const {createBrowserWritingGateway}=await import("./browserWritingGateway");
  const gateway=createBrowserWritingGateway(undefined,{initialBibliography:[{path:"sources/LOCAL.BIB",content:"@book{a,title={Synthetic}}"}]});
  const manuscript=await gateway.createManuscript({title:"Managed"});
  await expect(gateway.createFile(manuscript.id,"other.bib","raw")).rejects.toMatchObject({code:"managed_bibliography"});
  await expect(gateway.saveFile({manuscriptId:manuscript.id,relativePath:parseManuscriptPath("sources/LOCAL.BIB"),content:"raw"})).rejects.toMatchObject({code:"managed_bibliography"});
  await expect(gateway.renameFile(manuscript.id,"sources/LOCAL.BIB","other.bib")).rejects.toThrow("不能直接编辑");
  await expect(gateway.deleteFile(manuscript.id,"sources/LOCAL.BIB")).rejects.toThrow("不能直接编辑");
  await expect(gateway.renameDirectory(manuscript.id,"sources","renamed")).rejects.toThrow("不能直接编辑");
  await expect(gateway.deleteDirectory(manuscript.id,"sources")).rejects.toThrow("不能直接编辑");
  expect((await gateway.readFile(manuscript.id,"sources/LOCAL.BIB")).content).toContain("Synthetic");
});
