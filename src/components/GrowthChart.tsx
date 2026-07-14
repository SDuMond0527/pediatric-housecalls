import { useState } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import { boysHeight, girlsHeight, boysWeight, girlsWeight, type PercentileRow } from '../lib/cdcGrowthData'

export interface GrowthVitalPoint {
  ageYears: number
  heightCm?: number
  weightKg?: number
  date: string
}

interface Props {
  gender: string
  vitalPoints: GrowthVitalPoint[]
}

const P_LABELS = ['p3', 'p10', 'p25', 'p50', 'p75', 'p90', 'p97'] as const
const P_COLORS: Record<string, string> = {
  p3:  '#E0DFF8', p10: '#C8C5F2', p25: '#A9A4E8',
  p50: '#7F77DD',
  p75: '#A9A4E8', p90: '#C8C5F2', p97: '#E0DFF8',
}
const P_WIDTH: Record<string, number> = {
  p3: 1, p10: 1, p25: 1, p50: 2, p75: 1, p90: 1, p97: 1,
}

function buildChartData(
  refData: PercentileRow[],
  patientPoints: { age: number; value: number; date: string }[],
) {
  // Merge ref data rows (with patient=undefined) and patient rows (with percentiles=undefined)
  const rows: Record<string, Record<string, number | undefined>> = {}

  for (const r of refData) {
    rows[r.age] = { age: r.age, p3: r.p3, p10: r.p10, p25: r.p25, p50: r.p50, p75: r.p75, p90: r.p90, p97: r.p97 }
  }

  // Patient points — snap to nearest 0.1 yr to avoid key collisions with integer ages
  for (const p of patientPoints) {
    const key = p.age.toFixed(2)
    const existing = rows[key] ?? {}
    rows[key] = { ...existing, age: p.age, patient: p.value, patientDate: p.date as any }
  }

  return Object.values(rows).sort((a, b) => (a.age as number) - (b.age as number))
}

function CustomDot(props: any) {
  const { cx, cy, payload } = props
  if (payload?.patient == null) return null
  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill="#1D9E75" stroke="#fff" strokeWidth={2} />
    </g>
  )
}

function CustomTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null
  const patient = payload.find((p: any) => p.dataKey === 'patient')
  if (!patient) return null
  const date = payload[0]?.payload?.patientDate
  return (
    <div className="bg-white border border-[#E8E8E4] rounded-lg px-3 py-2 shadow text-[12px]">
      <div className="font-medium text-[#1A1A2E] mb-0.5">
        {patient.value?.toFixed(1)} {unit}
      </div>
      <div className="text-[#999]">Age {(label as number).toFixed(1)} yr</div>
      {date && <div className="text-[#999]">{date}</div>}
    </div>
  )
}

export function GrowthChart({ gender, vitalPoints }: Props) {
  const [mode, setMode] = useState<'height' | 'weight'>('height')

  const isMale = (gender ?? '').toUpperCase().startsWith('M')
  const refData = mode === 'height'
    ? (isMale ? boysHeight : girlsHeight)
    : (isMale ? boysWeight : girlsWeight)

  const unit = mode === 'height' ? 'cm' : 'kg'
  const yLabel = mode === 'height' ? 'Height (cm)' : 'Weight (kg)'

  const patientPoints = vitalPoints
    .filter(v => (mode === 'height' ? v.heightCm : v.weightKg) != null)
    .map(v => ({
      age: v.ageYears,
      value: (mode === 'height' ? v.heightCm : v.weightKg) as number,
      date: v.date,
    }))

  const chartData = buildChartData(refData, patientPoints)

  const hasPatientData = patientPoints.length > 0

  return (
    <div>
      {/* Mode toggle */}
      <div className="flex gap-2 mb-4">
        {(['height', 'weight'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
              mode === m ? 'bg-[#7F77DD] text-white' : 'bg-[#F1EFE8] text-[#555] hover:bg-[#EEEDFE]'
            }`}
          >
            {m === 'height' ? 'Height-for-age' : 'Weight-for-age'}
          </button>
        ))}
      </div>

      {!hasPatientData && (
        <div className="text-[12px] text-[#bbb] mb-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg px-3 py-2">
          No {mode} measurements recorded yet. Vitals entered during encounters will appear here.
        </div>
      )}

      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 24, bottom: 28, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F1EFE8" />
          <XAxis
            dataKey="age"
            type="number"
            domain={[2, 20]}
            ticks={[2, 4, 6, 8, 10, 12, 14, 16, 18, 20]}
            tick={{ fontSize: 11, fill: '#999' }}
            label={{ value: 'Age (years)', position: 'insideBottom', offset: -14, fontSize: 11, fill: '#aaa' }}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#999' }}
            width={44}
            label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 16, fontSize: 11, fill: '#aaa' }}
          />
          <Tooltip content={<CustomTooltip unit={unit} />} />

          {/* Percentile reference lines */}
          {P_LABELS.map(key => (
            <Line
              key={key}
              dataKey={key}
              dot={false}
              stroke={P_COLORS[key]}
              strokeWidth={P_WIDTH[key]}
              name={key.replace('p', '') + 'th'}
              connectNulls
              isAnimationActive={false}
            />
          ))}

          {/* Patient data */}
          <Line
            dataKey="patient"
            dot={<CustomDot />}
            activeDot={{ r: 7, fill: '#1D9E75', stroke: '#fff', strokeWidth: 2 }}
            stroke="#1D9E75"
            strokeWidth={1.5}
            strokeDasharray="3 4"
            connectNulls={false}
            name="Patient"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Percentile legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 px-1">
        {(['3rd', '10th', '25th', '50th', '75th', '90th', '97th'] as const).map((label, i) => {
          const key = P_LABELS[i]
          return (
            <span key={key} className="flex items-center gap-1 text-[10px] text-[#999]">
              <span style={{ display: 'inline-block', width: 16, height: 2, background: P_COLORS[key] }} />
              {label}
            </span>
          )
        })}
        {hasPatientData && (
          <span className="flex items-center gap-1 text-[10px] text-[#1A1A2E] font-medium">
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#1D9E75', border: '2px solid #fff', boxShadow: '0 0 0 1px #1D9E75' }} />
            Patient
          </span>
        )}
      </div>

      <div className="text-[10px] text-[#ccc] mt-3 text-center">
        Reference: CDC 2000 Growth Charts (NCHS) — Ages 2–20 · For clinical reference only
      </div>
    </div>
  )
}
