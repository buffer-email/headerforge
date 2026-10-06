import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Fixed row height in px. Must not change without remounting the list. */
  itemHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Stable key per row; falls back to the index when omitted. */
  itemKey?: (item: T, index: number) => string;
  /** Rows rendered above and below the viewport to hide scroll tearing. */
  overscan?: number;
  /** Viewport height in px, or "auto" to fill the remaining flex space. */
  height?: number | "auto";
  className?: string;
  "aria-label"?: string;
  "aria-rowcount"?: number;
  emptyState?: React.ReactNode;
}

/**
 * Windowed list renderer.
 *
 * The options dashboard can hold hundreds of header rules per profile. React
 * rendering every row turns each storage write into a full reconcile of the
 * whole list, which is what made bulk edits feel sticky. This renders only the
 * visible slice plus an overscan margin, so cost is proportional to viewport
 * height rather than to rule count.
 *
 * Rows must be a fixed height for this to work; that constraint is already
 * satisfied by the density system, which drives row height from CSS vars.
 */
export function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
  itemKey,
  overscan = 6,
  height = "auto",
  className,
  emptyState,
  ...aria
}: VirtualListProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => setViewportHeight(node.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [height]);

  // Reset scroll when the underlying collection is replaced (profile switch).
  useEffect(() => {
    const node = viewportRef.current;
    if (node) node.scrollTop = 0;
    setScrollTop(0);
  }, [items]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    // Round to whole rows so we do not re-render on sub-pixel scroll jitter.
    setScrollTop(Math.round(event.currentTarget.scrollTop));
  }, []);

  const total = items.length;
  const effectiveHeight =
    height === "auto" ? Math.max(viewportHeight, itemHeight * 8) : height;

  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(effectiveHeight / itemHeight) + overscan * 2;
  const end = Math.min(total, start + visibleCount);

  const slice: React.ReactNode[] = [];
  for (let index = start; index < end; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    slice.push(
      <div
        key={itemKey ? itemKey(item, index) : index}
        style={{ height: itemHeight, display: "flex", alignItems: "stretch" }}
      >
        {renderItem(item, index)}
      </div>,
    );
  }

  return (
    <div
      ref={viewportRef}
      className={`virtual-viewport ${className ?? ""}`}
      onScroll={handleScroll}
      style={height === "auto" ? undefined : { height }}
      tabIndex={-1}
      {...aria}
    >
      {total === 0 && emptyState}
      {total > 0 && (
        <div className="virtual-spacer" style={{ height: total * itemHeight }}>
          <div
            className="virtual-window"
            style={{ transform: `translateY(${start * itemHeight}px)` }}
          >
            {slice}
          </div>
        </div>
      )}
    </div>
  );
}