import { Outlet, useNavigate, NavLink } from 'react-router-dom'
import { useEffect } from 'react'
import { CalendarDays, Radio, Users, Settings, LogOut, Clock, BarChart2, FileBarChart, Receipt, Building2 } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

const NAV = [
  { to: '/admin/analytics',  icon: BarChart2,     label: 'Analytics' },
  { to: '/admin/reports',    icon: FileBarChart,  label: 'Reports' },
  { to: '/admin/schedule',   icon: CalendarDays,  label: 'Schedule' },
  { to: '/admin/waitlist',   icon: Clock,         label: 'Waitlist' },
  { to: '/admin/broadcasts', icon: Radio,         label: 'Broadcasts' },
  { to: '/admin/claims',     icon: Receipt,       label: 'Claims' },
  { to: '/admin/providers',  icon: Users,         label: 'Providers' },
  { to: '/admin/settings',   icon: Settings,      label: 'Settings' },
]

export function AdminLayout() {
  const { user, provider, loading, signOut } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) navigate('/login')
  }, [user, loading])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAFAF8]">
      <div className="font-display text-lg text-[#1A1A2E]/40">Loading...</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      <aside className="w-[220px] h-screen bg-[#1A1A2E] flex flex-col fixed left-0 top-0 z-40">
        <div className="px-5 py-5 border-b border-white/8">
          <div className="font-display text-base font-medium text-white leading-snug">PediatricHousecalls</div>
          <div className="text-[11px] text-white/40 mt-0.5">Admin portal</div>
        </div>

        <div className="px-5 py-4 border-b border-white/8 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-full bg-[#F1EFE8] flex items-center justify-center text-[11px] font-medium text-[#888780] flex-shrink-0">
            {provider?.initials || 'A'}
          </div>
          <div>
            <div className="text-[13px] font-medium text-white">{provider?.name || 'Admin'}</div>
            <div className="text-[11px] text-white/40 mt-0.5">Administrator</div>
          </div>
        </div>

        <nav className="flex-1 py-3 space-y-0.5">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-5 py-2.5 text-[13px] font-medium transition-all border-l-3 border-transparent
                ${isActive ? 'bg-[#7F77DD]/15 text-white border-l-[#7F77DD]' : 'text-white/55 hover:bg-white/5 hover:text-white/85'}`
              }>
              <Icon size={16} className="opacity-70" />
              {label}
            </NavLink>
          ))}
          {provider?.is_super_admin && (
            <>
              <div className="mx-5 my-2 border-t border-white/10" />
              <NavLink to="/admin/provision"
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-5 py-2.5 text-[13px] font-medium transition-all border-l-3 border-transparent
                  ${isActive ? 'bg-[#7F77DD]/15 text-white border-l-[#7F77DD]' : 'text-white/55 hover:bg-white/5 hover:text-white/85'}`
                }>
                <Building2 size={16} className="opacity-70" />
                Practices
              </NavLink>
            </>
          )}
        </nav>

        <div className="px-5 py-4 border-t border-white/8">
          {provider?.is_admin && provider?.role !== 'admin' && (
            <button onClick={() => navigate('/today')}
              className="w-full flex items-center justify-center gap-2 text-[12px] text-[#1D9E75]/80 hover:text-[#1D9E75] py-1.5 rounded-lg border border-[#1D9E75]/20 hover:bg-[#1D9E75]/10 transition-all mb-2">
              <CalendarDays size={13} /> My provider schedule
            </button>
          )}
          <button onClick={signOut}
            className="w-full flex items-center justify-center gap-2 text-[12px] text-white/40 hover:text-white/70 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 transition-all">
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </aside>

      <div className="ml-[220px]">
        <Outlet />
      </div>
    </div>
  )
}
