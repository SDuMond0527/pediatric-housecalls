import { Outlet, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { useAuth } from '../../contexts/AuthContext'
import { getBroadcasts } from '../../lib/api'

export function AppLayout() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [broadcastCount, setBroadcastCount] = useState(0)

  useEffect(() => {
    if (!loading && !user) navigate('/login')
  }, [user, loading])

  useEffect(() => {
    if (!user) return
    getBroadcasts({ open_only: 'true' })
      .then((data) => setBroadcastCount(Array.isArray(data) ? data.length : 0))
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
