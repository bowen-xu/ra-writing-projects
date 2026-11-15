import {
  createStableCitationKey,
  type CitationCandidate,
  type CitationScope,
} from "@research-assistant/writing";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@research-assistant/workbench-sdk/overlay";

interface CitationPickerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onInsert: (candidates: readonly CitationCandidate[]) => Promise<void>;
  readonly onSearch: (query: string, scope: CitationScope) => Promise<readonly CitationCandidate[]>;
}

export function CitationPicker(props: CitationPickerProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<CitationScope>("library");
  const [results, setResults] = useState<readonly CitationCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<"loading" | "ready" | "error" | "inserting">("loading");
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!props.open) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      setState("loading");
      setMessage(undefined);
      void props.onSearch(query, scope)
        .then((items) => {
          if (!active) return;
          setResults(items);
          setState("ready");
        })
        .catch((reason: unknown) => {
          if (!active) return;
          setMessage(errorMessage(reason));
          setState("error");
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [props.open, props.onSearch, query, scope]);

  useEffect(() => {
    if (props.open) { setSelectedIds(new Set()); setScope("library"); }
  }, [props.open]);

  const selected = useMemo(
    () => results.filter((candidate) => selectedIds.has(candidate.literatureItemId)),
    [results, selectedIds],
  );
  const occupied = useMemo(
    () => new Set(results.flatMap((candidate) => candidate.citationKey === undefined ? [] : [candidate.citationKey])),
    [results],
  );

  if (!props.open) return null;

  async function insert(): Promise<void> {
    if (selected.length === 0) return;
    setState("inserting");
    setMessage(undefined);
    try {
      await props.onInsert(selected);
      props.onClose();
    } catch (reason: unknown) {
      setMessage(errorMessage(reason));
      setState("error");
    }
  }

  return (
    <Dialog open portal backdrop={false} hideOnInteractOutside={false} hideOnEscape={state !== "inserting"}
      onClose={props.onClose} style={{position: "fixed"}} className="citation-picker-backdrop" aria-label="插入文献引用">
      <section className="citation-picker">
        <header>
          <div><span className="eyebrow">CITATIONS</span><h2>插入文献引用</h2></div>
          <button aria-label="关闭引用选择器" disabled={state === "inserting"} onClick={props.onClose} type="button">×</button>
        </header>
        <div className="citation-search-row">
          <input
            aria-label="搜索引用"
            autoFocus
            disabled={state === "inserting"}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="标题、作者、年份或 citation key"
            value={query}
          />
          <select aria-label="引用搜索范围" disabled={state === "inserting"} onChange={(event) => setScope(event.target.value as CitationScope)} value={scope}>
            <option value="project">当前项目</option>
            <option value="library">文献库</option>
          </select>
        </div>
        <div className="citation-results">
          {state === "loading" && <div className="citation-picker-state">正在检索文献…</div>}
          {state === "error" && <div className="citation-picker-state error" role="alert">{message}</div>}
          {state === "ready" && results.length === 0 && (
            <div className="citation-picker-state">没有匹配文献。可切换到全部文献或调整关键词。</div>
          )}
          {state !== "loading" && results.map((candidate) => {
            const key = candidate.citationKey ?? createStableCitationKey({
              importedKey: candidate.importedKey,
              firstAuthor: candidate.firstAuthor,
              ...(candidate.issuedYear === undefined ? {} : { issuedYear: candidate.issuedYear }),
              title: candidate.title,
            }, occupied);
            return (
              <label className="citation-result" key={candidate.literatureItemId}>
                <input
                  checked={selectedIds.has(candidate.literatureItemId)} disabled={state === "inserting"}
                  onChange={(event) => setSelectedIds((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(candidate.literatureItemId);
                    else next.delete(candidate.literatureItemId);
                    return next;
                  })}
                  type="checkbox"
                />
                <span>
                  <strong>{candidate.title}</strong>
                  <small>{[candidate.firstAuthor, candidate.issuedYear, candidate.containerTitle].filter(Boolean).join(" · ")}</small>
                  <em>{key}{candidate.hasPdf ? " · PDF" : ""}{candidate.hasEvidence ? " · 有证据" : ""}</em>
                  {candidate.warnings.length > 0 && <mark>{candidate.warnings.join("、")}</mark>}
                </span>
              </label>
            );
          })}
        </div>
        <footer>
          <span>{selected.length === 0 ? "选择文献后自动加入稿件参考文献" : `将插入 \\cite{${selected.map((candidate) => candidate.citationKey ?? "…").join(",")}}`}</span>
          <button className="ghost-button" disabled={state === "inserting"} onClick={props.onClose} type="button">取消</button>
          <button className="primary-button" disabled={selected.length === 0 || state === "inserting"} onClick={() => void insert()} type="button">
            {state === "inserting" ? "正在维护 BibTeX…" : "插入引用"}
          </button>
        </footer>
      </section>
    </Dialog>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
