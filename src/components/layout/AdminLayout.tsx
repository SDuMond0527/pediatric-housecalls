import { Outlet, useNavigate, NavLink } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { CalendarDays, Radio, Users, Settings, LogOut, Clock, BarChart2, FileBarChart, Receipt, Building2, Stethoscope, CalendarClock, Menu, X, ShieldCheck, FileText, BookOpen, DollarSign, Ban, Library } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { DemoBanner } from '../DemoBanner'
import { DEMO_MODE, PRACTICE_NAME } from '../../lib/practice'
import { getEraCount, getPendingWriteOffCount } from '../../lib/api'
import { dailyAffirmation } from '../../lib/affirmations'
import { GlobalPatientSearch } from '../GlobalPatientSearch'

const NAV = [
  { to: '/admin/analytics',  icon: BarChart2,     label: 'Analytics' },
  { to: '/admin/reports',    icon: FileBarChart,  label: 'Reports' },
  { to: '/admin/financial-reports', icon: DollarSign, label: 'Financial' },
  { to: '/admin/reports-schedule',  icon: FileBarChart, label: "Bookkeeping to-do's" },
  { to: '/admin/schedule',   icon: CalendarDays,  label: 'Schedule' },
  { to: '/admin/waitlist',   icon: Clock,         label: 'Waitlist' },
  { to: '/admin/broadcasts', icon: Radio,         label: 'Broadcasts' },
  { to: '/admin/claims',      icon: Receipt,       label: 'Claims', eraBadge: true },
  { to: '/admin/statements',  icon: FileText,      label: 'Statements' },
  { to: '/admin/patients',   icon: Stethoscope,   label: 'Patients' },
  { to: '/admin/providers',     icon: Users,         label: 'Providers' },
  { to: '/admin/availability',  icon: CalendarClock, label: 'Availability' },
  { to: '/admin/settings',      icon: Settings,      label: 'Settings' },
  { to: '/admin/pcps',          icon: BookOpen,      label: 'PCP Directory' },
  { to: '/admin/handbook',      icon: Library,       label: 'All things PHC' },
  { to: '/admin/audit-log',     icon: ShieldCheck,   label: 'Audit Log' },
]

function SidebarContent({ provider, signOut, eraCount, pendingWriteOffCount, onNav }: { provider: any; signOut: () => void; eraCount: number; pendingWriteOffCount: number; onNav?: () => void }) {
  const navigate = useNavigate()
  return (
    <aside className="w-[220px] h-screen bg-[#1A1A2E] flex flex-col">
      <div className="px-5 py-5 border-b border-white/8 flex items-center justify-between">
        <div>
          <div className="font-display text-base font-medium text-white leading-snug">{PRACTICE_NAME}</div>
          <div className="text-[11px] text-white/40 mt-0.5">Admin portal</div>
        </div>
        {onNav && (
          <button onClick={onNav} className="text-white/40 hover:text-white md:hidden">
            <X size={18} />
          </button>
        )}
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

      <nav className="flex-1 py-3 space-y-0.5 overflow-y-auto">
        {NAV.map(({ to, icon: Icon, label, eraBadge }) => (
          <NavLink key={to} to={to} onClick={onNav}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-5 py-2.5 text-[13px] font-medium transition-all border-l-3 border-transparent
              ${isActive ? 'bg-[#7F77DD]/15 text-white border-l-[#7F77DD]' : 'text-white/55 hover:bg-white/5 hover:text-white/85'}`
            }>
            <Icon size={16} className="opacity-70" />
            {label}
            {eraBadge && eraCount > 0 && (
              <span className="ml-auto bg-[#1D9E75] text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-full">
                {eraCount}
              </span>
            )}
          </NavLink>
        ))}
        {provider?.is_super_admin && (
          <>
            <div className="mx-5 my-2 border-t border-white/10" />
            <NavLink to="/admin/pending-write-offs" onClick={onNav}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-5 py-2.5 text-[13px] font-medium transition-all border-l-3 border-transparent
                ${isActive ? 'bg-[#7F77DD]/15 text-white border-l-[#7F77DD]' : 'text-white/55 hover:bg-white/5 hover:text-white/85'}`
              }>
              <Ban size={16} className="opacity-70" />
              Pending write-offs
              {pendingWriteOffCount > 0 && (
                <span className="ml-auto bg-[#EF4444] text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-full">
                  {pendingWriteOffCount}
                </span>
              )}
            </NavLink>
            <NavLink to="/admin/provision" onClick={onNav}
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
          <button onClick={() => { navigate('/today'); onNav?.() }}
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
  )
}

function greetingFor(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function AdminLayout() {
  const { user, provider, loading, signOut } = useAuth()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [eraCount, setEraCount] = useState(0)
  const [pendingWriteOffCount, setPendingWriteOffCount] = useState(0)

  useEffect(() => {
    if (!loading && !user) navigate('/login')
  }, [user, loading])

  useEffect(() => {
    if (!user) return
    const refresh = () => {
      getEraCount().then(d => setEraCount(d?.count ?? 0)).catch(() => {})
      getPendingWriteOffCount().then(d => setPendingWriteOffCount(d?.count ?? 0)).catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, 60000)
    return () => clearInterval(interval)
  }, [user])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAFAF8]">
      <div className="font-display text-lg text-[#1A1A2E]/40">Loading...</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      {/* Desktop sidebar */}
      <div className="hidden md:fixed md:left-0 md:top-0 md:block md:z-40">
        <SidebarContent provider={provider} signOut={signOut} eraCount={eraCount} pendingWriteOffCount={pendingWriteOffCount}/>
      </div>

      {/* Mobile overlay sidebar */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSidebarOpen(false)} />
          <div className="relative">
            <SidebarContent provider={provider} signOut={signOut} eraCount={eraCount} pendingWriteOffCount={pendingWriteOffCount} onNav={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      <div className="md:ml-[220px]">
        {DEMO_MODE && <DemoBanner />}
        {/* Mobile header */}
        <div className="md:hidden flex items-center gap-3 px-4 h-14 bg-[#1A1A2E] border-b border-white/10">
          <button onClick={() => setSidebarOpen(true)} className="p-2 rounded-lg hover:bg-white/10">
            <Menu size={18} className="text-white" />
          </button>
          <span className="font-display font-medium text-white">{PRACTICE_NAME}</span>
        </div>
        {/* Greeting bar — visible above every admin page. Mirrors the
            Today page's header so admins get the same warm welcome as
            providers. */}
        {provider && (
          <div className="bg-white border-b border-[#E8E8E4] px-6 md:px-8 py-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="font-display text-[18px] font-medium text-[#1A1A2E] truncate">
                {greetingFor()}, {(provider.name || 'friend').split(' ').slice(-2)[0]}!
              </div>
              <div className="text-[12px] text-[#7F77DD] mt-0.5 font-medium truncate">
                {dailyAffirmation()}
              </div>
            </div>
            <div className="hidden sm:block flex-shrink-0 w-full max-w-xs">
              <GlobalPatientSearch />
            </div>
          </div>
        )}
        <Outlet />
      </div>
    </div>
  )
}
