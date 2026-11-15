import { lazy, Suspense, useRef } from "react";
import { isWritingNotePath } from "@research-assistant/writing";
const WritingNoteEditor = lazy(() => import("./WritingNoteEditor"));

interface Props {
  readonly retainedProjects?: readonly { readonly manuscriptId: string; readonly openPaths: readonly string[] }[];
  readonly manuscriptId: string;
  readonly activePath: string | undefined;
  readonly content: string;
  readonly openPaths: readonly string[];
  readonly onChange: (value: string) => void;
  readonly focusRequest?: (import("../sourceNavigation").WritingFocusRequest & {readonly path: string}) | undefined;
}
/** The host owns editor lifetime; save echoes never replace a live session. */
export function WritingNoteSessions(props: Props): React.JSX.Element {
  const current = useRef(props); current.current = props;
  const sessions = useRef(new Map<string, { manuscriptId: string; path: string; initial: string; latest: string; revision: number }>());
  const retained = props.retainedProjects ?? [{ manuscriptId: props.manuscriptId, openPaths: props.openPaths }];
  for (const [key, session] of sessions.current) if (!retained.some(project => project.manuscriptId === session.manuscriptId && project.openPaths.includes(session.path))) sessions.current.delete(key);
  if (props.activePath && isWritingNotePath(props.activePath)) {
    const key = JSON.stringify([props.manuscriptId, props.activePath]);
    const previous = sessions.current.get(key);
    if (!previous || previous.latest !== props.content) {
      sessions.current.set(key, { manuscriptId: props.manuscriptId, path: props.activePath, initial: props.content, latest: props.content, revision: (previous?.revision ?? 0) + 1 });
    }
  }
  return <>{[...sessions.current].map(([key, session]) => <div className="writing-note-session" hidden={session.manuscriptId !== props.manuscriptId || session.path !== props.activePath} key={key + ":" + session.revision}>
    <Suspense fallback={<p>正在加载笔记编辑器…</p>}>
      <WritingNoteEditor manuscriptId={session.manuscriptId} content={session.initial}
        blockSourcePath={["writings", session.manuscriptId, ...session.path.split("/")]}
        sourceNavigation={session.manuscriptId === props.manuscriptId && session.path === props.activePath && props.focusRequest?.path === session.path && props.focusRequest.blockId
          ? {...props.focusRequest, blockId: props.focusRequest.blockId} : undefined}
        onChange={(value) => { session.latest = value; const host = current.current;
          if (host.manuscriptId === session.manuscriptId && host.activePath === session.path) host.onChange(value); }} />
    </Suspense>
  </div>)}</>;
}
