import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { FamilyAuthProvider } from './contexts/FamilyAuthContext'
import { AppLayout } from './components/layout/AppLayout'
import { AdminLayout } from './components/layout/AdminLayout'
import { FamilyLayout } from './components/layout/FamilyLayout'
import { Login } from './pages/Login'
import { Today } from './pages/Today'
import { Week } from './pages/Week'
import { Availability } from './pages/Availability'
import { Broadcasts } from './pages/Broadcasts'
import { Waitlist } from './pages/Waitlist'
import { Settings } from './pages/Settings'
import { AdminSchedule } from './pages/admin/AdminSchedule'
import { AdminBroadcasts } from './pages/admin/AdminBroadcasts'
import { AdminProviders } from './pages/admin/AdminProviders'
import { PatientChart } from './pages/PatientChart'
import { Patients } from './pages/Patients'
import { AdminAnalytics } from './pages/admin/AdminAnalytics'
import { AdminReports } from './pages/admin/AdminReports'
import { AdminBookings } from './pages/admin/AdminBookings'
import { AdminWaitlist } from './pages/admin/AdminWaitlist'
import { AdminClaims } from './pages/admin/AdminClaims'
import { AdminProvision } from './pages/admin/AdminProvision'
import { AdminAuditLog } from './pages/admin/AdminAuditLog'
import { AdminStatements } from './pages/admin/AdminStatements'
import { AdminPcps } from './pages/admin/AdminPcps'
import { FamilyLogin } from './pages/family/FamilyLogin'
import { FamilySignup } from './pages/family/FamilySignup'
import { FamilySetup } from './pages/family/FamilySetup'
import { FamilyAddCard } from './pages/family/FamilyAddCard'
import { FamilyDashboard } from './pages/family/FamilyDashboard'
import { BookVisit } from './pages/family/BookVisit'
import { FamilyProfile } from './pages/family/FamilyProfile'
import { FamilyForgotPassword } from './pages/family/FamilyForgotPassword'
import { FamilyResetPassword } from './pages/family/FamilyResetPassword'
import { FamilyVisitHistory } from './pages/family/FamilyVisitHistory'
import { ForgotPassword } from './pages/ForgotPassword'
import { ResetPassword } from './pages/ResetPassword'
import { Terms } from './pages/Terms'
import { Privacy } from './pages/Privacy'
import { FAQ } from './pages/FAQ'
import { Landing } from './pages/Landing'
import { useAuth } from './contexts/AuthContext'

function RootRedirect() {
  const { user, provider, loading } = useAuth()
  if (loading) return null
  if (!user) return <Landing />
  if (!provider) return <div className="min-h-screen flex items-center justify-center text-[#555] text-sm">No provider record found for this account. Contact your administrator.</div>
  if (provider.is_admin) return <Navigate to="/admin/analytics" replace />
  return <Navigate to="/today" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Password reset pages — no auth context needed */}
        <Route path="/family/forgot-password" element={<FamilyForgotPassword />} />
        <Route path="/family/reset-password"  element={<FamilyResetPassword />} />

        {/* Family portal — own auth context */}
        <Route path="/family/*" element={
          <FamilyAuthProvider>
            <Routes>
              <Route path="login"    element={<FamilyLogin />} />
              <Route path="signup"   element={<FamilySignup />} />
              <Route path="setup"    element={<FamilySetup />} />
              <Route path="add-card" element={<FamilyAddCard />} />
              <Route element={<FamilyLayout />}>
                <Route path="dashboard" element={<FamilyDashboard />} />
                <Route path="book"      element={<BookVisit />} />
                <Route path="profile"   element={<FamilyProfile />} />
                <Route path="visits"    element={<FamilyVisitHistory />} />
              </Route>
            </Routes>
          </FamilyAuthProvider>
        } />

        {/* Provider password reset — no auth context needed */}
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password"  element={<ResetPassword />} />

        {/* Provider & admin portal */}
        <Route path="/*" element={
          <AuthProvider>
            <Routes>
              <Route path="/login"   element={<Login />} />
              <Route path="/terms"            element={<Terms />} />
              <Route path="/privacy"          element={<Privacy />} />
              <Route path="/faq"              element={<FAQ />} />
              <Route index element={<RootRedirect />} />
              <Route element={<AppLayout />}>
                <Route path="today"          element={<Today />} />
                <Route path="week"           element={<Week />} />
                <Route path="patients"       element={<Patients />} />
                <Route path="chart/:childId" element={<PatientChart />} />
                <Route path="availability"   element={<Availability />} />
                <Route path="broadcasts"     element={<Broadcasts />} />
                <Route path="waitlist"       element={<Waitlist />} />
                <Route path="settings"       element={<Settings />} />
              </Route>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<Navigate to="/admin/analytics" replace />} />
                <Route path="analytics"  element={<AdminAnalytics />} />
                <Route path="reports"    element={<AdminReports />} />
                <Route path="bookings"   element={<AdminBookings />} />
                <Route path="schedule"   element={<AdminSchedule />} />
                <Route path="waitlist"   element={<AdminWaitlist />} />
                <Route path="broadcasts" element={<AdminBroadcasts />} />
                <Route path="claims"     element={<AdminClaims />} />
                <Route path="patients"        element={<Patients />} />
                <Route path="chart/:childId" element={<PatientChart />} />
                <Route path="providers"      element={<AdminProviders />} />
                <Route path="availability"   element={<Availability />} />
                <Route path="provision"  element={<AdminProvision />} />
                <Route path="settings"   element={<Settings />} />
                <Route path="audit-log"   element={<AdminAuditLog />} />
                <Route path="statements" element={<AdminStatements />} />
                <Route path="pcps"       element={<AdminPcps />} />
              </Route>
            </Routes>
          </AuthProvider>
        } />
      </Routes>
    </BrowserRouter>
  )
}
