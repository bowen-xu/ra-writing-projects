import {cloneElement, useState, type ComponentProps, type ReactElement} from "react";
import {LatexEditor} from "./LatexEditor";

type SourceElement = ReactElement<ComponentProps<typeof LatexEditor>>;

/** One source view survives note/loading surfaces; file sessions still own history. */
export function RetainedLatexEditor({source, visible}: {readonly source: SourceElement | undefined; readonly visible: boolean}) {
  const [retained, setRetained] = useState(source);
  // Adjust before committing children: a new source identity must never render
  // the previous source's props for a frame while a passive effect catches up.
  if (source && source !== retained) setRetained(source);
  const current = source ?? retained;
  return current ? <div className="writing-retained-source" hidden={!visible || !source} inert={!visible || !source} style={{height: "100%"}}>
    {cloneElement(current, {active: visible && Boolean(source), suspended: !source})}
  </div> : null;
}
