import { Outlet, useNavigate, NavLink } from 'react-router-dom'
import { useEffect } from 'react'
import { CalendarPlus, Home, User, LogOut, ClipboardList } from 'lucide-react'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { DemoBanner } from '../DemoBanner'
import { DEMO_MODE, PRACTICE_NAME } from '../../lib/practice'

export function FamilyLayout() {
  const { user, family, loading, signOut } = useFamilyAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) navigate('/family/login')
  }, [user, loading])

  useEffect(() => {
    if (!loading && user && !family) navigate('/family/setup')
  }, [user, family, loading])

  useEffect(() => {
    if (!loading && user && family && !family.square_card_id) navigate('/family/add-card')
  }, [user, family, loading])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAFAF8]">
      <div className="font-display text-lg text-[#1A1A2E]/40">Loading...</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      {DEMO_MODE && <DemoBanner />}
      <header className="bg-white border-b border-[#E8E8E4] sticky top-0 z-40">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="font-display text-lg font-medium text-[#1A1A2E]">
            {PRACTICE_NAME}
          </div>
          <div className="flex items-center gap-1">
            <NavLink to="/family/dashboard"
              className={({ isActive }) => `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${isActive ? 'bg-[#EEEDFE] text-[#3C3489]' : 'text-[#555] hover:bg-[#F1EFE8]'}`}>
              <Home size={14} /> Home
            </NavLink>
            <NavLink to="/family/visits"
              className={({ isActive }) => `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${isActive ? 'bg-[#EEEDFE] text-[#3C3489]' : 'text-[#555] hover:bg-[#F1EFE8]'}`}>
              <ClipboardList size={14} /> Visits
            </NavLink>
            <NavLink to="/family/book"
              className={({ isActive }) => `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${isActive ? 'bg-[#EEEDFE] text-[#3C3489]' : 'text-[#555] hover:bg-[#F1EFE8]'}`}>
              <CalendarPlus size={14} /> Book a visit
            </NavLink>
            <NavLink to="/family/profile"
              className={({ isActive }) => `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${isActive ? 'bg-[#EEEDFE] text-[#3C3489]' : 'text-[#555] hover:bg-[#F1EFE8]'}`}>
              <User size={14} /> Profile
            </NavLink>
            <button onClick={signOut}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-[#555] hover:bg-[#F1EFE8] transition-colors">
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
