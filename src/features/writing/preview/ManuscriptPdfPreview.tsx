import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { PdfRect, PdfSource } from "@research-assistant/core/pdf-view";
import { PdfView, PdfViewController, PdfViewControls } from "@research-assistant/workbench-sdk/pdf";
import { notify } from "@research-assistant/workbench-sdk/feedback";
import { writingPdfRect, writingReadingPosition, type PdfReadingPosition } from "./writingPdfCoordinates";

interface Props {
  readonly source: PdfSource;
  readonly active: boolean;
  readonly toolbarTarget?: HTMLElement | null;
  readonly onShowPdf?: () => void;
  readonly onReadingPosition?: (position: PdfReadingPosition) => void;
  readonly onDisplayedVersion?: (revision: string | undefined) => void;
  readonly locationRequest?: PdfRect & { readonly page: number; readonly token: number };
  readonly onInverseSearch: (page: number, x: number, y: number) => void;
}

export function ManuscriptPdfPreview(props: Props): React.JSX.Element {
  const controller = useMemo(() => new PdfViewController(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLElement>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const [visible, setVisible] = useState(false);
  const [marker, setMarker] = useState<{ pageIndex: number; rect: PdfRect }>();
  const sourceKey = `${props.source.key}:${props.source.revision}`;
  const showing = controller.isShowing(props.source);
  useEffect(() => {
    const container = containerRef.current, viewerElement = viewerRef.current;
    if (!container || !viewerElement) return;
    setMarker(undefined);
    props.onDisplayedVersion?.(undefined);
    void controller.open({ source: props.source, container, viewerElement, active: props.active && visible,
      initialScale: { kind: "page-width" }, scaleLimits: { min: .2, max: 2.2 } });
  }, [controller, props.source.key, props.source.revision, props.source.bytes]);
  useEffect(() => () => { controller.close(); }, [controller]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const check = (): void => {
      setVisible(container.clientWidth > 0 && container.clientHeight > 0);
      const current = callbacks.current;
      if (controller.isShowing(current.source)) {
        const point = controller.adapter.readingPoint();
        if (point) current.onReadingPosition?.(writingReadingPosition(point, current.source));
      }
    };
    const observer = new ResizeObserver(check); observer.observe(container); check();
    return () => observer.disconnect();
  }, [controller]);
  useEffect(() => { controller.setActive(props.active && visible); }, [controller, props.active, visible, showing]);
  useEffect(() => { if (state.error) notify.error(`无法更新 PDF：${state.error}`); }, [state.error]);
  useEffect(() => {
    callbacks.current.onDisplayedVersion?.(showing ? props.source.revision : undefined);
  }, [showing, sourceKey]);
  useEffect(() => {
    if (!showing) return;
    const point = controller.adapter.readingPoint();
    if (point) callbacks.current.onReadingPosition?.(writingReadingPosition(point, props.source));
    // Read callbacks through the ref above. CompilePanel intentionally creates
    // its adapter callback during render, so it must not be an effect
    // dependency.
  }, [controller, showing, sourceKey, state.viewState, state.pageHosts, visible]);
  useEffect(() => {
    const request = props.locationRequest;
    if (!request || !showing) return;
    let cancelled = false;
    let timer: number | undefined;
    const pageIndex = request.page - 1;
    void (async () => {
      const box = await controller.adapter.loadPageBox(pageIndex);
      if (!box || cancelled) return;
      const raw = writingPdfRect(request, box);
      const rect = await controller.adapter.normalizedPdfRect(pageIndex, raw);
      if (!rect || cancelled || !controller.isShowing(callbacks.current.source)) return;
      controller.navigate({ pageIndex, left: raw.x, top: raw.y + raw.height, visibilityMargin: 72 });
      setMarker({ pageIndex, rect });
      timer = window.setTimeout(() => setMarker(undefined), 1800);
    })().catch((reason: unknown) => { if (!cancelled) notify.error(String(reason)); });
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [controller, props.locationRequest, showing, sourceKey]);
  const controls = <PdfViewControls controller={controller} state={state} scopeRef={scopeRef} onShowPdf={() => callbacks.current.onShowPdf?.()} />;
  return <div className="manuscript-pdf-preview" data-external-toolbar={props.toolbarTarget !== undefined}
    ref={(element) => { scopeRef.current = element?.closest<HTMLElement>(".writing-preview-column") ?? element; }}>
    {props.toolbarTarget ? createPortal(controls, props.toolbarTarget) : props.toolbarTarget === undefined ? controls : null}
    <div className="pdf-view-stage">
      <PdfView controller={controller} containerRef={containerRef} viewerRef={viewerRef}
        ready={state.ready} active={props.active && visible} characterSelectionAvailable={showing && state.characterSelectionAvailable}
        pageHosts={state.pageHosts} documentVersion={sourceKey}
        onScroll={() => { if (showing) { const point = controller.adapter.readingPoint(); if (point) callbacks.current.onReadingPosition?.(writingReadingPosition(point, props.source)); } }}
        onPageDoubleClick={(point) => { if (showing) { const position = writingReadingPosition(point, props.source); props.onInverseSearch(position.page, position.x, position.y); } }}
        renderPageOverlay={(pageIndex) => marker?.pageIndex === pageIndex ? <span className="synctex-marker" style={{ left: `${marker.rect.x * 100}%`, top: `${marker.rect.y * 100}%`, width: `${marker.rect.width * 100}%`, height: `${marker.rect.height * 100}%` }} /> : null} />
      {showing && !state.characterSelectionAvailable && <div className="pdf-selection-unavailable" role="status">此 PDF 缺少字形坐标，暂时无法选文；仍可阅读和搜索。</div>}
      {!state.ready && <div className="compile-placeholder" role="status">{state.error ?? "正在加载 PDF…"}</div>}
    </div>
  </div>;
}
