// The shared rendering core for charts, maps and flow graphs (docs/research/d3-everywhere.md):
// React draws the SVG; d3 modules only compute (scales, ticks, projections, layouts). No
// d3-selection, no d3-axis, no animation. Every figure gets the same size hook, axis, legends,
// tooltip, roving keyboard focus, figure/table toggle, label dodge and theme colours.
export { useSize, type Size } from "@/components/ui-blocks/viz/use-size";
export { clamp, linearAxis, tickCount } from "@/components/ui-blocks/viz/ticks";
export { AxisLabels, Grid } from "@/components/ui-blocks/viz/axis";
export { BinLegend, Legend, LegendItem, ScaleLegend, SizeLegend, SquareSwatch } from "@/components/ui-blocks/viz/legend";
export { binDecimals, binLabels, edge, sizeLegendValues, tidy } from "@/components/ui-blocks/viz/legend-model";
export { VizTooltip } from "@/components/ui-blocks/viz/tooltip";
export { linearStep, spatialStep, useRoving, type At } from "@/components/ui-blocks/viz/roving";
export { ViewToggle, VizTable, type Column } from "@/components/ui-blocks/viz/view-toggle";
export { dodge, fitText, placeTip, textWidth, type Box, type LabelItem } from "@/components/ui-blocks/chart-layout";
export {
  isTone,
  readableOn,
  seriesColor,
  tokenName,
  TONE_FILL,
  TONE_WORD,
  TONES,
  useResolvedTokens,
  type Tone,
} from "@/components/ui-blocks/viz/theme";
