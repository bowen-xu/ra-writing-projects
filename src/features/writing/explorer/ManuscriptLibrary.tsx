import {ManuscriptRowActions,type ManuscriptLibraryOperations} from "./ManuscriptRowActions";
import { Archive, ArrowDown, ArrowUp, FileText, FolderOpen, Plus, Search } from "lucide-react";
import { ManuscriptDeleteDialog } from "./ManuscriptDeleteDialog";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Manuscript } from "@research-assistant/writing";

interface ManuscriptLibraryProps {
  readonly operations?: ManuscriptLibraryOperations;
  readonly manuscripts: readonly Manuscript[];
  readonly isLoading: boolean;
  readonly onOpen: (id: string) => void;
  readonly onCreate: () => void;
  readonly onStatusChange: (manuscript: Manuscript) => void;
  readonly onDelete: (manuscript: Manuscript) => Promise<void>;
  readonly transferActions: ReactNode;
}

interface ManuscriptSort {
  readonly key: "updated" | "title";
  readonly ascending: boolean;
}

export function ManuscriptLibrary(props: ManuscriptLibraryProps): React.JSX.Element {
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [deleting, setDeleting] = useState<Manuscript>();
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ManuscriptSort>();
  const visible = useMemo(() => props.manuscripts
    .filter((item) => item.status === filter && item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => (sort?.key === "title" ? a.title.localeCompare(b.title) : a.updatedAt.localeCompare(b.updatedAt)) * (sort?.ascending ? 1 : -1)),
  [props.manuscripts, filter, query, sort]);
  function changeSort(next: "updated" | "title"): void {
    setSort((current) => current?.key !== next ? { key: next, ascending: true }
      : current.ascending ? { key: next, ascending: false } : undefined);
  }
  const SortIcon = sort?.ascending ? ArrowUp : ArrowDown;
  return (
    <div className="writing-library">
      {deleting && <ManuscriptDeleteDialog manuscript={deleting} onDelete={props.onDelete} returnFocus={deleteTrigger.current} onClose={() => setDeleting(undefined)} />}
      <aside aria-label="稿件分类">
        <h2>论文写作</h2>
        <button className={filter === "active" ? "active" : ""} aria-pressed={filter === "active"} onClick={() => setFilter("active")} type="button"><FolderOpen size={18} />我的稿件<span>{props.manuscripts.filter((item) => item.status === "active").length}</span></button>
        <button className={filter === "archived" ? "active" : ""} aria-pressed={filter === "archived"} onClick={() => setFilter("archived")} type="button"><Archive size={18} />已归档<span>{props.manuscripts.filter((item) => item.status === "archived").length}</span></button>
        <p>从一篇稿件开始，组织源码、引用和编译结果。</p>
      </aside>
      <main>
        <header><div><h1>{filter === "active" ? "我的稿件" : "已归档稿件"}</h1><p>{filter === "active" ? "继续写作，或开始一篇新的论文。" : "归档保留全部源码与编译记录，可随时恢复。"}</p></div><button className="writing-primary" onClick={props.onCreate} type="button"><Plus size={17} />新建稿件</button></header>
        <div className="writing-library-tools"><label><Search size={18} /><input aria-label="搜索稿件" placeholder="搜索稿件标题…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{props.transferActions}</div>
        <div className="writing-project-table">
          <table aria-label="稿件列表">
            <thead><tr><th aria-sort={sort?.key === "title" ? sort.ascending ? "ascending" : "descending" : "none"}><button onClick={() => changeSort("title")} type="button">标题{sort?.key === "title" && <SortIcon size={14} />}</button></th><th aria-sort={sort?.key === "updated" ? sort.ascending ? "ascending" : "descending" : "none"}><button onClick={() => changeSort("updated")} type="button">最近修改{sort?.key === "updated" && <SortIcon size={14} />}</button></th><th aria-label="稿件操作" /></tr></thead>
            <tbody>{visible.map((item) => (
              <tr key={item.id}><td><button className="writing-project-link" onClick={() => props.onOpen(item.id)} type="button"><FileText size={19} /><span>{item.title}</span></button></td><td><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</time></td><td><ManuscriptRowActions item={item} operations={props.operations} onStatusChange={() => props.onStatusChange(item)} onDelete={trigger => {deleteTrigger.current=trigger;setDeleting(item);}} /></td></tr>
            ))}</tbody>
          </table>
          {visible.length === 0 && <div className="writing-library-empty"><FolderOpen size={32} /><h3>{props.isLoading ? "正在载入稿件…" : query ? "没有找到匹配稿件" : filter === "archived" ? "暂无已归档稿件" : "开始你的第一篇论文"}</h3><p>{query ? "试试其他标题关键词。" : "你可以新建稿件，也可以导入已有的 LaTeX 工程。"}</p></div>}
        </div>
      </main>
    </div>
  );
}
