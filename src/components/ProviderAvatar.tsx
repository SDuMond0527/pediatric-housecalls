/**
 * Circular provider avatar for booking / offer / history surfaces.
 * Shows a real photo when photo_url is set, otherwise renders a
 * colored initial fallback so no provider looks "missing."
 *
 * Sara requested 2026-09-17: photos next to provider names on the
 * family portal so parents can see who they're booking with.
 * Default size (md) is 64px — same convention as Doximity, Zocdoc,
 * modern booking flows.
 */
export function ProviderAvatar({
  photoUrl,
  name,
  size = 'md',
}: {
  photoUrl?: string | null
  name?: string | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const px = size === 'sm' ? 40 : size === 'lg' ? 96 : 64
  const initial = String(name ?? '?')
    .replace(/^(Dr|Ms|Mr|Mrs|Miss|MD|NP|PNP|RN|CMA|FAAP)\.?\s*/i, '')
    .trim()
    .charAt(0)
    .toUpperCase() || '?'

  // Deterministic color from the name so each provider gets a
  // consistent hue on the fallback (no jarring re-renders).
  const seed = String(name ?? '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const bgs = ['#EEEDFE', '#E1F5EE', '#FFF3E6', '#FDEDED', '#EEF6FB', '#F1EFE8']
  const fgs = ['#3C3489', '#085041', '#8A4B10', '#8C1E1E', '#2D7BA6', '#555']
  const idx = seed % bgs.length
  const bg = bgs[idx]
  const fg = fgs[idx]

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name || 'Provider'}
        style={{ width: px, height: px }}
        className="rounded-full object-cover object-top flex-shrink-0 border border-[#E8E8E4]"
      />
    )
  }

  return (
    <div
      style={{ width: px, height: px, background: bg, color: fg, fontSize: Math.round(px * 0.42) }}
      className="rounded-full flex items-center justify-center font-semibold flex-shrink-0 border border-[#E8E8E4]"
      aria-label={name || 'Provider'}>
      {initial}
    </div>
  )
}
