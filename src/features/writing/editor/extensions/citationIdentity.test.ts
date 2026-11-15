// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { getOriginalDoc } from "@codemirror/merge";
import { WritingFileSession } from "../writingFileSessions";
import { parseManuscriptPath } from "@research-assistant/writing";

it("renames both review sides without adding an undo step and preserves history identities", () => {
  const source = "\\cite{key:a} and \\cite{key:b}";
  const session = new WritingFileSession({manuscriptId:"m",relativePath:parseManuscriptPath("main.tex")},source);
  const view = new EditorView({state:session.state,dispatchTransactions:trs => session.accept(trs)});
  session.attach(view);
  try {
    session.rekeyCitations([{referenceId:"A",baseKey:"key",from:"key:a",to:"key:a"},{referenceId:"B",baseKey:"key",from:"key:b",to:"key:b"}]);
    // Delete A. B becomes the sole live reference and takes the unsuffixed key.
    view.dispatch({changes:{from:0,to:17},userEvent:"delete.cut"});
    session.rekeyCitations([{referenceId:"A",baseKey:"key",from:"key:a",to:"key:a"},{referenceId:"B",baseKey:"key",from:"key:b",to:"key"}]);
    expect(session.read().content).toBe("\\cite{key}");
    expect(getOriginalDoc(view.state).toString()).toBe("\\cite{key}");
    expect(undo(view)).toBe(true);
    expect(session.read().content).toBe("\\cite{key:a} and \\cite{key}");
    expect(redo(view)).toBe(true);
    expect(session.read().content).toBe("\\cite{key}");
  } finally {session.detach(view);view.destroy();}
});

it("undo keeps the original identity when another reference has taken its old bare name", () => {
  const session = new WritingFileSession({manuscriptId:"m",relativePath:parseManuscriptPath("main.tex")},"\\cite{key} and \\cite{key:b}");
  const view = new EditorView({state:session.state,dispatchTransactions:trs => session.accept(trs)});session.attach(view);
  try {
    session.rekeyCitations([{referenceId:"A",baseKey:"key",from:"key",to:"key"},{referenceId:"B",baseKey:"key",from:"key:b",to:"key:b"}]);
    view.dispatch({changes:{from:0,to:15},userEvent:"delete.cut"});
    session.rekeyCitations([{referenceId:"A",baseKey:"key",from:"key",to:"key:unuseda"},{referenceId:"B",baseKey:"key",from:"key:b",to:"key"}]);
    expect(undo(view)).toBe(true);
    expect(session.read().content).toBe("\\cite{key:unuseda} and \\cite{key}");
  } finally {session.detach(view);view.destroy();}
});

it("ordinary text undo cannot bring back a key from before the system rename", () => {
  const session = new WritingFileSession({manuscriptId:"m",relativePath:parseManuscriptPath("main.tex")},"\\cite{key}");
  const view = new EditorView({state:session.state,dispatchTransactions:trs => session.accept(trs)});session.attach(view);
  try {
    session.rekeyCitations([{referenceId:"A",baseKey:"key",from:"key",to:"key"}]);
    view.dispatch({changes:{from:0,insert:"prefix "},userEvent:"input.type"});
    session.rekeyCitations([{referenceId:"A",baseKey:"key",from:"key",to:"key:a"}]);
    expect(undo(view)).toBe(true);
    expect(session.read().content).toBe("\\cite{key:a}");
    expect(session.read().reviewBaseline).toBe("\\cite{key:a}");
    expect(redo(view)).toBe(true);
    expect(session.read().content).toBe("prefix \\cite{key:a}");
  } finally {session.detach(view);view.destroy();}
});

it("normalizes historical review keys after an earlier tag changes their offsets", () => {
  const session = new WritingFileSession({manuscriptId:"m",relativePath:parseManuscriptPath("main.tex")},"\\cite{a} and \\cite{b}");
  const view = new EditorView({state:session.state,dispatchTransactions:trs => session.accept(trs)});session.attach(view);
  try {
    session.rekeyCitations([{referenceId:"A",baseKey:"a",from:"a",to:"a"},{referenceId:"B",baseKey:"b",from:"b",to:"b"}]);
    view.dispatch({changes:{from:13,to:21},userEvent:"delete.cut"});
    session.rekeyCitations([{referenceId:"A",baseKey:"a",from:"a",to:"a:longsuffix"},{referenceId:"B",baseKey:"b",from:"b",to:"b:a"}]);
    expect(undo(view)).toBe(true);
    expect(session.read().content).toBe("\\cite{a:longsuffix} and \\cite{b:a}");
    expect(session.read().reviewBaseline).toBe(session.read().content);
  } finally {session.detach(view);view.destroy();}
});

it("rejects toolbar edits during migration and resumes editing afterwards", () => {
  const session = new WritingFileSession({manuscriptId:"m",relativePath:parseManuscriptPath("main.tex")},"\\cite{key}");
  const unlock = session.lockCitationMigration();
  session.dispatch({changes:{from:0,insert:"blocked "},userEvent:"input.type"});
  expect(session.read().content).toBe("\\cite{key}");
  session.rekeyCitations([{referenceId:"A",baseKey:"key",from:"key",to:"key:a"}]);
  unlock();
  session.dispatch({changes:{from:0,insert:"allowed "},userEvent:"input.type"});
  expect(session.read().content).toBe("allowed \\cite{key:a}");
});
