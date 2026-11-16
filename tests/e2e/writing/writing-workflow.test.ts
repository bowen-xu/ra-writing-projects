import { describe, expect, it } from "vitest";

import { browserWritingGateway } from "../../../src/features/writing/gateway/browserWritingGateway";

describe("LaTeX writing workflow", () => {
  it("restores a managed multi-file editing session without launching a browser", async () => {
    const projectId = crypto.randomUUID();
    const manuscript = await browserWritingGateway.createManuscript({
      projectId,
      title: "端到端写作稿件",
    });
    const section = await browserWritingGateway.createFile(
      manuscript.id,
      "sections/introduction.tex",
      "\\section{引言}\n中文编辑内容。\n",
    );
    const root = await browserWritingGateway.readFile(manuscript.id, manuscript.rootPath);
    await browserWritingGateway.saveFile({
      manuscriptId: manuscript.id,
      relativePath: manuscript.rootPath,
      expectedSha256: root.sha256,
      content: root.content.replace("\\end{document}", "\\input{sections/introduction}\n\\end{document}"),
    });
    await browserWritingGateway.saveSession({
      manuscriptId: manuscript.id,
      openPaths: [manuscript.rootPath, section.relativePath],
      activePath: section.relativePath,
      cursorState: { [section.relativePath]: 12 },
      layoutState: { autoCompile: true, narrowPane: "editor" },
    });
    await browserWritingGateway.saveRecoveryDraft({
      manuscriptId: manuscript.id,
      relativePath: section.relativePath,
      baseSha256: section.sha256,
      content: `${section.content}% 尚未保存`,
    });

    const reopened = (await browserWritingGateway.listManuscripts(projectId))[0];
    const session = await browserWritingGateway.getSession(manuscript.id);
    const recovery = await browserWritingGateway.listRecoveryDrafts(manuscript.id);
    expect(reopened?.id).toBe(manuscript.id);
    expect((await browserWritingGateway.listFiles(manuscript.id)).map((file) => file.relativePath).sort()).toEqual([
      "main.tex",
      "sections/introduction.tex",
    ]);
    expect(session?.activePath).toBe("sections/introduction.tex");
    expect(session?.layoutState.autoCompile).toBe(true);
    expect(recovery[0]?.content).toContain("尚未保存");

    const archived = await browserWritingGateway.archiveManuscript(manuscript.id);
    expect(archived.status).toBe("archived");
  });
});
