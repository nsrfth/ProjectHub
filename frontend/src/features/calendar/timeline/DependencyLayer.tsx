import type { TimelineDependencyEdge } from './types';

/**
 * SVG overlay for task dependency connectors (phase 2).
 * Renders nothing today but reserves the layer so FINISH_TO_START /
 * START_TO_START edges can be drawn without restructuring the chart.
 */
interface Props {
  edges: TimelineDependencyEdge[];
  rowIndexByTaskId: Map<string, number>;
  axisStartMs: number;
  dayPx: number;
  chartWidth: number;
  headerHeight: number;
  rowHeight: number;
}

export default function DependencyLayer({
  edges,
  rowIndexByTaskId,
  axisStartMs,
  dayPx,
  chartWidth,
  headerHeight,
  rowHeight,
}: Props): JSX.Element | null {
  if (edges.length === 0) return null;

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      width={chartWidth}
      height="100%"
      aria-hidden
      data-testid="timeline-dependency-layer"
    >
      <g>
        {edges.map((edge) => {
          const fromIdx = rowIndexByTaskId.get(edge.fromTaskId);
          const toIdx = rowIndexByTaskId.get(edge.toTaskId);
          if (fromIdx === undefined || toIdx === undefined) return null;
          const y1 = headerHeight + fromIdx * rowHeight + rowHeight / 2;
          const y2 = headerHeight + toIdx * rowHeight + rowHeight / 2;
          const x1 = chartWidth * 0.3;
          const x2 = chartWidth * 0.7;
          void axisStartMs;
          void dayPx;
          return (
            <path
              key={edge.id}
              d={`M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="#94a3b8"
              strokeWidth={1.5}
              markerEnd="url(#timeline-arrow)"
              opacity={0.6}
            />
          );
        })}
      </g>
      <defs>
        <marker
          id="timeline-arrow"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8" />
        </marker>
      </defs>
    </svg>
  );
}
