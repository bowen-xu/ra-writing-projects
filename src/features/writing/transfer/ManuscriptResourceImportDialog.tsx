import {useRef, useState, type FormEvent} from "react";
import {Dialog} from "@research-assistant/workbench-sdk/overlay";

interface ManuscriptResourceImportDialogProps {
  readonly onCancel: () => void;
  readonly onConfirm: (directory: string) => void;
}

export function ManuscriptResourceImportDialog(props: ManuscriptResourceImportDialogProps): React.JSX.Element {
  const [directory, setDirectory] = useState("figures");
  const submitted = useRef(false);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const destination = directory.trim();
    if (submitted.current || destination.length === 0) return;
    submitted.current = true;
    props.onConfirm(destination);
  }

  return (
    <Dialog open portal backdrop={false} hideOnInteractOutside={false}
      onClose={props.onCancel} className="writing-create-overlay" style={{position: "fixed"}}
      aria-label="上传资源目录">
      <form onSubmit={submit}>
        <h2>上传资源</h2>
        <label>
          资源保存到稿件中的目录
          <input autoFocus value={directory} onChange={event => setDirectory(event.target.value)} />
        </label>
        <div>
          <button className="ghost-button" onClick={props.onCancel} type="button">取消</button>
          <button className="primary-button" disabled={directory.trim().length === 0} type="submit">上传</button>
        </div>
      </form>
    </Dialog>
  );
}
