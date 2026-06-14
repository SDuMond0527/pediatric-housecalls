import { NavLink, useNavigate } from 'react-router-dom'
import { CalendarDays, LayoutGrid, Clock, Radio, Settings, LogOut, ListOrdered, BarChart2 } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

const NAV = [
  { to: '/today',        icon: CalendarDays,  label: "Today's schedule" },
  { to: '/week',         icon: LayoutGrid,    label: 'Week view' },
  { to: '/availability', icon: Clock,         label: 'Availability' },
  { to: '/broadcasts',   icon: Radio,         label: 'Broadcasts', badge: true },
  { to: '/waitlist',     icon: ListOrdered,   label: 'Waitlist' },
  { to: '/settings',     icon: Settings,      label: 'Settings' },
]

export function Sidebar({ broadcastCount }: { broadcastCount: number }) {
  const { provider, signOut } = useAuth()
  const navigate = useNavigate()
  if (!provider) return null

  return (
    <aside className="w-[220px] h-screen bg-[#1A1A2E] flex flex-col fixed left-0 top-0 z-40">
      <div className="px-5 py-5 border-b border-white/8">
        <div className="font-display text-base font-medium text-white leading-snug">PediatricHousecalls</div>
        <div className="text-[11px] text-white/40 mt-0.5">Provider portal</div>
      </div>

      <div className="px-5 py-4 border-b border-white/8 flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0"
          style={{ background: provider.avatar_color, color: provider.avatar_text_color }}>
          {provider.initials}
        </div>
        <div>
          <div className="text-[13px] font-medium text-white leading-snug">{provider.name}</div>
          <div className="text-[11px] text-white/40 mt-0.5">{provider.role} · {provider.states.join(', ')}</div>
        </div>
      </div>

      <nav className="flex-1 py-3 space-y-0.5">
        {NAV.map(({ to, icon: Icon, label, badge }) => (
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
          </NavLink>
        ))}
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
