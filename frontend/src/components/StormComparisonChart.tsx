import { useId } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StormBacktestSample } from "../api/client";

const chartTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dateLabel = (value: number) => chartTime.format(value);
const chartMargin = { top: 8, right: 16, bottom: 2, left: 0 };
const tickStyle = { fontSize: 11, fill: "var(--muted)" };
const axisStyle = { stroke: "var(--control-line)" };

export default function StormComparisonChart({ samples, selectedAt, gaugeId }: {
  samples: StormBacktestSample[];
  selectedAt: string;
  gaugeId: string;
}) {
  const syncId = useId();
  const data = samples.map((sample) => ({ ...sample, time: Date.parse(sample.timestamp) }));
  const selected = Date.parse(selectedAt);
  const start = data[0].time;
  const end = data[data.length - 1].time;
  const domain: [number, number] = start === end ? [start - 60_000, end + 60_000] : [start, end];

  return <div className="storm-compare-charts" aria-hidden="true">
    <p className="storm-chart-title">Rainfall at gauge {gaugeId} (mm)</p>
    <ResponsiveContainer width="100%" height={120} minWidth={0}>
      <BarChart data={data} margin={chartMargin} syncId={syncId}>
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis type="number" scale="time" dataKey="time" domain={domain} hide />
        <YAxis width={46} tick={tickStyle} axisLine={axisStyle} tickCount={4} domain={[0, "auto"]} />
        <Tooltip labelFormatter={dateLabel} isAnimationActive={false} />
        <ReferenceLine x={selected} stroke="var(--control-line)" strokeDasharray="3 3" />
        <Bar name="Rainfall" dataKey="rainfall_mm" unit=" mm" fill="var(--control-line)" maxBarSize={12} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
    <p className="storm-chart-title">Drain water depth (m)</p>
    <ResponsiveContainer width="100%" height={216} minWidth={0}>
      <LineChart data={data} margin={chartMargin} syncId={syncId}>
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis type="number" scale="time" dataKey="time" domain={domain} tickFormatter={dateLabel}
          tick={tickStyle} axisLine={axisStyle} minTickGap={36} />
        <YAxis width={46} tick={tickStyle} axisLine={axisStyle} tickCount={4} domain={[0, "auto"]} />
        <Tooltip labelFormatter={dateLabel} isAnimationActive={false} />
        <ReferenceLine x={selected} stroke="var(--control-line)" strokeDasharray="3 3" />
        <Line type="linear" name="Observed" dataKey="observed_depth_m" unit=" m" stroke="var(--ink)"
          strokeWidth={2} dot={data.length === 1} isAnimationActive={false} />
        <Line type="linear" name="Modeled" dataKey="modeled_depth_m" unit=" m" stroke="var(--accent)"
          strokeWidth={2} strokeDasharray="6 3" dot={data.length === 1} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
