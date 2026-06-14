import { Outlet, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'

export function AppLayout() {
  const { user, provider, loading } = useAuth()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [broadcastCount, setBroadcastCount] = useState(0)

  useEffect(() => {
    if (!loading && (!user || !provider)) navigate('/login')
  }, [user, provider, loading])
  useEffect(() => {
    if (!loading && provider?.role === 'admin') navigate('/admin/analytics', { replace: true })
  }, [provider, loading])

  useEffect(() => {
    if (!user) return
    supabase.from('broadcasts').select('id', { count: 'exact' }).eq('is_open', true)
      .then(({ count }) => setBroadcastCount(count ?? 0))
  }, [user])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FAFAF8]">
        <div className="font-display text-lg text-[#1A1A2E]/40">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      <div className="hidden md:block">
        <Sidebar broadcastCount={broadcastCount} />
      </div>

      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSidebarOpen(false)} />
          <div className="relative">
            <Sidebar broadcastCount={broadcastCount} />
          </div>
        </div>
      )}

      <div className="md:ml-[220px]">
        <div className="md:hidden flex items-center gap-3 px-4 h-14 bg-white border-b border-[#E8E8E4]">
          <button onClick={() => setSidebarOpen(true)} className="p-2 rounded-lg hover:bg-[#F1EFE8]">
            <Menu size={18} />
          </button>
          <span className="font-display font-medium text-[#1A1A2E]">PediatricHousecalls</span>
        </div>
        <Outlet context={{ broadcastCount, setBroadcastCount }} />
      </div>
    </div>
  )
}
