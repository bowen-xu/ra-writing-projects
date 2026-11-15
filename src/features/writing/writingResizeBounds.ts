export type WritingResizeEdge = "explorer" | "preview";

/** Use the same percentage limits as the rendered grid, including hidden explorer. */
export function writingResizeBounds(edge: WritingResizeEdge, target?: HTMLElement | null) {
  const minimum = edge === "explorer" ? 160 : 280;
  const maximum = edge === "explorer" ? 380 : 720;
  const grid = target?.closest<HTMLElement>(".writing-grid");
  if (!grid) return { minimum, maximum };
  const width = grid.getBoundingClientRect().width;
  if (width <= 0) return { minimum, maximum };
  const property = edge === "explorer" ? "--writing-explorer-limit" : "--writing-preview-limit";
  const fallback = edge === "explorer" ? 24 : grid.dataset.explorerVisible === "false" ? 50 : 43;
  const percentage = Number.parseFloat(getComputedStyle(grid).getPropertyValue(property)) || fallback;
  const limit = Math.min(maximum, width * percentage / 100);
  return { minimum: Math.min(minimum, limit), maximum: limit };
}
export function boundedWritingWidth(width: number, bounds: { minimum: number; maximum: number }): number {
  return Math.max(bounds.minimum, Math.min(bounds.maximum, width));
}
