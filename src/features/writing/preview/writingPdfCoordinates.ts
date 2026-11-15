import type { PdfDocumentIdentity, PdfPagePoint, PdfRect } from "@research-assistant/core/pdf-view";

export interface PdfReadingPosition extends PdfDocumentIdentity { readonly page: number; readonly x: number; readonly y: number }
/** SyncTeX uses one-based pages and a top-down origin; PDF user space is bottom-up. */
export function writingReadingPosition(point: PdfPagePoint, identity: PdfDocumentIdentity): PdfReadingPosition {
  return { key: identity.key, revision: identity.revision, page: point.pageIndex + 1, x: Math.max(0, point.x - point.pageBox[0]), y: Math.max(0, point.pageBox[3] - point.y) };
}
export function writingPdfRect(rect: PdfRect, box: readonly [number, number, number, number]): PdfRect {
  return { x: box[0] + rect.x, y: box[3] - rect.y - rect.height, width: rect.width, height: rect.height };
}
