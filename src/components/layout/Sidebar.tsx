import { NavLink, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { CalendarDays, LayoutGrid, Clock, Radio, Settings, LogOut, ListOrdered, BarChart2, Users, CalendarClock, HeartPulse, BookOpen, FlaskConical, FileText, PhoneCall, Package } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useSettings } from '../../contexts/PracticeSettingsContext'
import { PRACTICE_NAME } from '../../lib/practice'
import { getResultsCounts, type ResultsCounts } from '../../lib/api'
import type { PracticeSettings } from '../../lib/practiceSettings'

type NavItem = {
  to: string
  icon: typeof CalendarDays
  label: string
  badge?: boolean                                           // broadcasts — amber pill, uses broadcastCount
  resultsBadge?: (c: ResultsCounts) => number                // results module — red pill, uses counts endpoint
  flag?: keyof PracticeSettings  // when set, nav item hides if flag is off
  extraFlag?: keyof PracticeSettings  // AND condition with flag
  superAdminBypassExtraFlag?: boolean  // super-admin sees the item even when extraFlag is off (staging escape hatch)
  adminOnly?: boolean            // only show when provider is admin / super_admin
}

const NAV: NavItem[] = [
  { to: '/today',        icon: CalendarDays,  label: "Today's schedule" },
  { to: '/week',         icon: LayoutGrid,    label: 'Week view' },
  { to: '/patients',     icon: Users,         label: 'Patients' },
  { to: '/results/pathology',   icon: FlaskConical, label: 'Pathology inbox',    flag: 'uses_results_module', resultsBadge: c => c.pathology_pending },
  { to: '/results/labs',        icon: FileText,     label: 'Labs inbox',         flag: 'uses_results_module', resultsBadge: c => c.labs_pending },
  { to: '/admin/callbacks',     icon: PhoneCall,    label: 'Patient callbacks',  flag: 'uses_results_module', resultsBadge: c => c.pathology_signed + c.labs_signed },
  { to: '/availability', icon: Clock,         label: 'Availability' },
  { to: '/broadcasts',   icon: Radio,         label: 'Broadcasts', badge: true, flag: 'uses_broadcasts' },
  { to: '/waitlist',     icon: ListOrdered,   label: 'Waitlist',                flag: 'uses_waitlist' },
  { to: '/cpr-requests', icon: HeartPulse,    label: 'CPR requests',            flag: 'uses_cpr_classes' },
  { to: '/shifts',       icon: CalendarClock, label: 'On-call shifts',          flag: 'uses_oncall_shifts' },
  { to: '/handbook',     icon: BookOpen,      label: 'All things PHC',          flag: 'uses_handbook' },
  // Provider-facing "Order supplies" — gated by BOTH uses_supply_orders
  // and providers_can_order_supplies so Pam can seed the catalog before
  // any provider sees it. Super-admin bypasses the second flag so Sara
  // can test it on her own provider view before flipping the practice
  // switch. Sara 2026-11-19.
  { to: '/order-supplies',     icon: Package, label: 'Order supplies',           flag: 'uses_supply_orders', extraFlag: 'providers_can_order_supplies', superAdminBypassExtraFlag: true },
  // Admin-facing "Supply orders" queue + catalog editor. Visible only
  // to admins when uses_supply_orders is on. Red badge drives from
  // pending supply_requests count.
  { to: '/admin/supply-orders', icon: Package, label: 'Supply orders',          flag: 'uses_supply_orders', adminOnly: true, resultsBadge: c => c.supply_requests_pending },
  { to: '/settings',     icon: Settings,      label: 'Settings' },
]

export function Sidebar({ broadcastCount }: { broadcastCount: number }) {
  const { provider, signOut } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()
  const [resultsCounts, setResultsCounts] = useState<ResultsCounts>({
    pathology_pending: 0, pathology_signed: 0, labs_pending: 0, labs_signed: 0,
    supply_requests_pending: 0,
  })
  // Poll counts every 60s so new path/lab reports + supply requests
  // show the red pill without needing a refresh. Polls when either
  // the Results module OR supply orders are on. Sara 2026-11-17 + 2026-11-19.
  useEffect(() => {
    const anyCountDriver = settings.uses_results_module || settings.uses_supply_orders
    if (!anyCountDriver) return
    let cancelled = false
    const fetchCounts = () => {
      getResultsCounts()
        .then(c => { if (!cancelled) setResultsCounts(c) })
        .catch(() => {})
    }
    fetchCounts()
    const id = window.setInterval(fetchCounts, 60_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [settings.uses_results_module, settings.uses_supply_orders])
  if (!provider) return null

  const isAdmin = !!((provider as any)?.is_admin || (provider as any)?.is_super_admin)
  const isSuperAdmin = !!(provider as any)?.is_super_admin
  const visibleNav = NAV.filter(item => {
    if (item.flag && !settings[item.flag]) return false
    if (item.extraFlag && !settings[item.extraFlag]) {
      // Super-admins can opt to see the item anyway for staging / dog-fooding.
      if (!(item.superAdminBypassExtraFlag && isSuperAdmin)) return false
    }
    if (item.adminOnly && !isAdmin) return false
    return true
  })

  return (
    <aside className="w-[220px] h-screen bg-[#1A1A2E] flex flex-col fixed left-0 top-0 z-40">
      <div className="px-5 py-5 border-b border-white/8">
        <div className="font-display text-base font-medium text-white leading-snug">{provider?.practice_name || PRACTICE_NAME}</div>
        <div className="text-[11px] text-white/40 mt-0.5">Provider portal</div>
      </div>

      <div className="px-5 py-4 border-b border-white/8 flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0"
          style={{ background: provider.avatar_color, color: provider.avatar_text_color }}>
          {provider.initials}
        </div>
        <div>
          <div className="text-[13px] font-medium text-white leading-snug">{provider.name}</div>
          <div className="text-[11px] text-white/40 mt-0.5">{provider.role}{provider.states?.length ? ` · ${provider.states.join(', ')}` : ''}</div>
        </div>
      </div>

      <nav className="flex-1 py-3 space-y-0.5">
        {visibleNav.map(({ to, icon: Icon, label, badge, resultsBadge }) => {
          const resultsBadgeCount = resultsBadge ? resultsBadge(resultsCounts) : 0
          return (
            <NavLink key={to} to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-5 py-2.5 text-[13px] font-medium transition-all border-l-3 border-transparent
                ${isActive ? 'bg-[#7F77DD]/15 text-white border-l-[#7F77DD]' : 'text-white/55 hover:bg-white/5 hover:text-white/85'}`
              }>
              <Icon size={16} className="flex-shrink-0 opacity-70" />
              {label}
              {badge && broadcastCount > 0 && (
                <span className="ml-auto bg-[#EF9F27] text-[#633806] text-[10px] font-semibold px-1.5 py-0.5 rounded-full">
                  {broadcastCount}
                </span>
              )}
              {resultsBadgeCount > 0 && (
                <span className="ml-auto bg-[#DC2626] text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-full">
                  {resultsBadgeCount}
                </span>
              )}
            </NavLink>
          )
        })}
      </nav>

      <div className="px-5 py-4 border-t border-white/8">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-[#1D9E75]" />
          <span className="text-[12px] text-white/50">On duty today</span>
        </div>
        {provider.is_admin && (
          <button onClick={() => navigate('/admin/analytics')}
            className="w-full flex items-center justify-center gap-2 text-[12px] text-[#7F77DD]/80 hover:text-[#7F77DD] py-1.5 rounded-lg border border-[#7F77DD]/20 hover:bg-[#7F77DD]/10 transition-all mb-2">
            <BarChart2 size={13} /> Switch to admin view
          </button>
        )}
        <button onClick={signOut}
          className="w-full flex items-center justify-center gap-2 text-[12px] text-white/40 hover:text-white/70 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 transition-all">
          <LogOut size={13} /> Sign out
        </button>
      </div>
    </aside>
  )
}
