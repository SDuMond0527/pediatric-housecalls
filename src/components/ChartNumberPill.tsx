/**
 * Renders a chart number (e.g. "GoRoam221") as a small monospace pill.
 *
 * Extracted so every patient-display surface (chart header, patient list,
 * schedule, waitlist, claims, statements, family portal, search, etc.)
 * shows the chart number identically. Do not inline this pattern in a
 * new surface — reach for this component instead so a future prefix
 * change or style tweak is a one-file edit.
 */
export function ChartNumberPill({
  value,
  size = 'sm',
  className = '',
}: {
  value: string | null | undefined
  size?: 'xs' | 'sm' | 'md'
  className?: string
}) {
  if (!value) return null
  const sizeCls = size === 'xs'
    ? 'text-[9px]  px-1    py-[1px]'
    : size === 'md'
    ? 'text-[12px] px-2    py-0.5'
    : 'text-[10px] px-1.5  py-0.5'
  return (
    <span
      className={`inline-flex items-center font-mono font-semibold text-[#5B54B2] bg-[#EEEDFE] border border-[#DDDBF9] rounded-full whitespace-nowrap ${sizeCls} ${className}`}
      title="Chart number"
    >
      {value}
    </span>
  )
}
