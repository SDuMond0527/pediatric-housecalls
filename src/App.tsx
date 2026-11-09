import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { FamilyAuthProvider } from './contexts/FamilyAuthContext'
import { PracticeSettingsProvider, FlagGuardedRoute } from './contexts/PracticeSettingsContext'
import { AppLayout } from './components/layout/AppLayout'
import { AdminLayout } from './components/layout/AdminLayout'
import { FamilyLayout } from './components/layout/FamilyLayout'
import { Login } from './pages/Login'
import { Today } from './pages/Today'
import { Week } from './pages/Week'
import { Availability } from './pages/Availability'
import { Broadcasts } from './pages/Broadcasts'
import { Waitlist } from './pages/Waitlist'
import { Shifts } from './pages/Shifts'
import { Settings } from './pages/Settings'
import { AdminSchedule } from './pages/admin/AdminSchedule'
import { AdminBroadcasts } from './pages/admin/AdminBroadcasts'
import { AdminProviders } from './pages/admin/AdminProviders'
import { PatientChart } from './pages/PatientChart'
import { Patients } from './pages/Patients'
import { AdminAnalytics } from './pages/admin/AdminAnalytics'
import { AdminReports } from './pages/admin/AdminReports'
import { AdminBookings } from './pages/admin/AdminBookings'
import { CprRequests } from './pages/CprRequests'
import { Handbook } from './pages/Handbook'
import { ClaimQuestion } from './pages/ClaimQuestion'
import { AdminSpecialists } from './pages/admin/AdminSpecialists'
import { AdminWaitlist } from './pages/admin/AdminWaitlist'
import { AdminClaims } from './pages/admin/AdminClaims'
import { AdminConvenienceFees } from './pages/admin/AdminConvenienceFees'
import { AdminProvision } from './pages/admin/AdminProvision'
import { AdminPracticeSettings } from './pages/admin/AdminPracticeSettings'
import { AdminAuditLog } from './pages/admin/AdminAuditLog'
import { AdminSchoolNotes } from './pages/admin/AdminSchoolNotes'
import { AdminStatements } from './pages/admin/AdminStatements'
import { AdminMarketing } from './pages/admin/AdminMarketing'
import { AdminReferrals } from './pages/admin/AdminReferrals'
import { AdminAgencies } from './pages/admin/AdminAgencies'
import { AdminStudOptions } from './pages/admin/AdminStudOptions'
import { MockupVisitPrep } from './pages/admin/MockupVisitPrep'
import { ReferralIvFluids } from './pages/public/ReferralIvFluids'
import { AgencyReferral } from './pages/public/AgencyReferral'
import { AdminPcps } from './pages/admin/AdminPcps'
import { AdminViewAsParent } from './pages/admin/AdminViewAsParent'
import { AdminFinancialReports } from './pages/admin/AdminFinancialReports'
import { AdminPendingWriteOffs } from './pages/admin/AdminPendingWriteOffs'
import { AdminBillingAgent } from './pages/admin/AdminBillingAgent'
import { AdminUnmatchedEras } from './pages/admin/AdminUnmatchedEras'
import { AdminReportsSchedule } from './pages/admin/AdminReportsSchedule'
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
import { FamilySchoolExcuseRequest } from './pages/family/FamilySchoolExcuseRequest'
import { FamilySchoolNotePicker } from './pages/family/FamilySchoolNotePicker'
import { FamilySchoolNotes } from './pages/family/FamilySchoolNotes'
import { FamilyLabs } from './pages/family/FamilyLabs'
import { FamilyRadiology } from './pages/family/FamilyRadiology'
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

        {/* Public referral form — targeted by QR codes distributed to urgent cares. */}
        <Route path="/referral/iv-fluids" element={<ReferralIvFluids />} />
        <Route path="/referral/agency/:slug" element={<AgencyReferral />} />

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
                <Route path="school-notes" element={<FamilySchoolNotes />} />
                <Route path="labs"      element={<FamilyLabs />} />
                <Route path="radiology" element={<FamilyRadiology />} />
                <Route path="school-excuse-request" element={<FamilySchoolExcuseRequest />} />
                <Route path="school-note"           element={<FamilySchoolNotePicker />} />
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
            <PracticeSettingsProvider>
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
                <Route path="broadcasts"     element={<FlagGuardedRoute flag="uses_broadcasts"><Broadcasts /></FlagGuardedRoute>} />
                <Route path="waitlist"       element={<Waitlist />} />
                <Route path="shifts"         element={<Shifts />} />
                <Route path="settings"       element={<Settings />} />
                <Route path="cpr-requests"   element={<FlagGuardedRoute flag="uses_cpr_classes"><CprRequests /></FlagGuardedRoute>} />
                <Route path="handbook"       element={<Handbook />} />
                <Route path="claim-question/:claimId" element={<ClaimQuestion />} />
              </Route>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<Navigate to="/admin/analytics" replace />} />
                <Route path="analytics"  element={<AdminAnalytics />} />
                <Route path="reports"    element={<AdminReports />} />
                <Route path="bookings"   element={<AdminBookings />} />
                <Route path="schedule"   element={<AdminSchedule />} />
                <Route path="waitlist"   element={<AdminWaitlist />} />
                <Route path="broadcasts" element={<FlagGuardedRoute flag="uses_broadcasts" redirectTo="/admin/analytics"><AdminBroadcasts /></FlagGuardedRoute>} />
                <Route path="claims"     element={<FlagGuardedRoute flag="accepts_insurance" redirectTo="/admin/analytics"><AdminClaims /></FlagGuardedRoute>} />
                <Route path="billing-agent" element={<FlagGuardedRoute flag="accepts_insurance" redirectTo="/admin/analytics"><AdminBillingAgent /></FlagGuardedRoute>} />
                <Route path="unmatched-eras" element={<FlagGuardedRoute flag="accepts_insurance" redirectTo="/admin/analytics"><AdminUnmatchedEras /></FlagGuardedRoute>} />
                <Route path="convenience-fees" element={<FlagGuardedRoute flag="uses_convenience_fees" redirectTo="/admin/analytics"><AdminConvenienceFees /></FlagGuardedRoute>} />
                <Route path="patients"        element={<Patients />} />
                <Route path="chart/:childId" element={<PatientChart />} />
                <Route path="providers"      element={<AdminProviders />} />
                <Route path="availability"   element={<Availability />} />
                <Route path="provision"  element={<AdminProvision />} />
                <Route path="practice-settings" element={<AdminPracticeSettings />} />
                <Route path="settings"   element={<Settings />} />
                <Route path="audit-log"    element={<AdminAuditLog />} />
                <Route path="school-notes" element={<AdminSchoolNotes />} />
                <Route path="statements" element={<FlagGuardedRoute flag="uses_self_pay_statements" redirectTo="/admin/analytics"><AdminStatements /></FlagGuardedRoute>} />
                <Route path="marketing"  element={<AdminMarketing />} />
                <Route path="referrals"  element={<FlagGuardedRoute flag="uses_booking_requests" redirectTo="/admin/analytics"><AdminReferrals /></FlagGuardedRoute>} />
                <Route path="agencies"   element={<FlagGuardedRoute flag="uses_booking_requests" redirectTo="/admin/analytics"><AdminAgencies /></FlagGuardedRoute>} />
                <Route path="stud-options" element={<FlagGuardedRoute flag="uses_ear_piercing" redirectTo="/admin/analytics"><AdminStudOptions /></FlagGuardedRoute>} />
                <Route path="mockup-visit-prep" element={<MockupVisitPrep />} />
                <Route path="pcps"       element={<AdminPcps />} />
                <Route path="view-as-parent/:familyId" element={<AdminViewAsParent />} />
                <Route path="financial-reports" element={<AdminFinancialReports />} />
                <Route path="pending-write-offs" element={<AdminPendingWriteOffs />} />
                <Route path="reports-schedule" element={<AdminReportsSchedule />} />
                <Route path="handbook"           element={<Handbook />} />
                <Route path="specialists"        element={<AdminSpecialists />} />
              </Route>
            </Routes>
            </PracticeSettingsProvider>
          </AuthProvider>
        } />
      </Routes>
    </BrowserRouter>
  )
}
