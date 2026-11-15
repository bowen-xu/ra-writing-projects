import {useEffect, useEffectEvent} from "react";
import type {CitationBinding, ManuscriptFile} from "@research-assistant/writing";
import type {WritingGateway} from "../gateway";
import type {WritingFileSessions} from "../editor/writingFileSessions";
import type {WritingCitationKeys} from "./WritingCitationKeys";
import {errorMessage} from "../workspaceState";

/** Recheck committed project changes, not which already-open file is visible. */
export function useWritingCitationReconciliation(options: {
  readonly enabled: boolean;
  readonly manuscriptId: string | undefined;
  readonly activePath: string | undefined;
  readonly files: readonly ManuscriptFile[];
  readonly gateway: WritingGateway;
  readonly citationKeys: Pick<WritingCitationKeys, "reconcile">;
  readonly fileSessions: WritingFileSessions;
  readonly setFiles: (files: readonly ManuscriptFile[]) => void;
  readonly setCitationBindings: (bindings: readonly CitationBinding[]) => void;
  readonly setContent: (content: string) => void;
  readonly setContentHash: (hash: string | undefined) => void;
  readonly markSourceChanged: () => void;
  readonly setError: (message: string) => void;
}): void {
  const {enabled, manuscriptId, files, gateway, citationKeys} = options;
  const revision = JSON.stringify(files.map(file => [file.relativePath, file.sha256]));
  // A pending reconciliation may finish after the user selects another file.
  // Publish the current file's session rather than a captured former path.
  const publish = useEffectEvent((updated: readonly ManuscriptFile[], bindings: readonly CitationBinding[]) => {
    options.setFiles(updated); options.setCitationBindings(bindings);
    const session = manuscriptId && options.activePath
      ? options.fileSessions.get({manuscriptId, relativePath: options.activePath}) : undefined;
    if (session) {options.setContent(session.read().content); options.setContentHash(session.savedSha256);}
    options.markSourceChanged();
  });
  const reportError = useEffectEvent((reason: unknown) => options.setError(errorMessage(reason)));
  useEffect(() => {
    if (!enabled || !manuscriptId) return;
    let current = true;
    void citationKeys.reconcile(manuscriptId).then(async changed => {
      if (!current || !changed) return;
      const [updated, bindings] = await Promise.all([gateway.listFiles(manuscriptId), gateway.listCitationBindings(manuscriptId)]);
      if (current) publish(updated, bindings);
    }).catch(reason => {if (current) reportError(reason);});
    return () => {current = false;};
  }, [enabled, manuscriptId, revision, citationKeys, gateway]);
}
