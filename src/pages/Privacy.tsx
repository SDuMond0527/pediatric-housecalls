import { Link } from 'react-router-dom'
import { PracticeLogo } from '../lib/practice'

export function Privacy() {
  return (
    <div className="min-h-screen bg-[#FAFAF8]" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-5 text-center">
        <PracticeLogo className="h-16 w-auto mx-auto mb-2" />
        <div className="text-[13px] text-[#999]">Provider Portal · <Link to="/login" className="text-[#7F77DD] hover:underline">Back to login</Link></div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12 pb-20">
        <h1 className="text-3xl font-semibold text-[#1A1A2E] mb-2">Privacy Policy</h1>
        <p className="text-[13px] text-[#999] mb-10">Effective Date: July 1, 2026 · Last Updated: June 30, 2026</p>

        <Section title="1. Introduction">
          <p>GoRoam Health, LLC ("GoRoam Health," "we," "us," or "our") operates the GoRoam Health provider platform ("Platform") located at phc-team.com. This Privacy Policy describes how we collect, use, protect, and handle information in connection with the Platform.</p>
          <p>The Platform handles Protected Health Information (PHI) on behalf of medical practices ("Covered Entities") under HIPAA. GoRoam Health acts as a Business Associate as defined under HIPAA and processes PHI only as directed by and on behalf of the Covered Entity, in accordance with an executed Business Associate Agreement (BAA).</p>
        </Section>

        <Section title="2. Information We Handle">
          <p><strong>Protected Health Information (PHI):</strong> The Platform stores and processes patient demographic information, appointment and visit records, encounter notes, diagnoses, medications and prescriptions, insurance information, and other clinical data entered by authorized practice users. This data is governed by HIPAA and your BAA with GoRoam Health, not solely by this Privacy Policy.</p>
          <p><strong>Provider and Staff Information:</strong> We collect name, email address, professional credentials (NPI, DEA number where applicable), role, and login activity for authorized platform users.</p>
          <p><strong>Usage and System Data:</strong> Standard access logs including IP addresses, browser type, and feature usage for security monitoring and platform improvement.</p>
        </Section>

        <Section title="3. How We Use Information">
          <p>We use the information on the Platform to:</p>
          <ul>
            <li>Provide scheduling, documentation, claims, and e-prescribing functionality to your practice.</li>
            <li>Transmit prescriptions to pharmacies via DoseSpot and the Surescripts network.</li>
            <li>Send appointment and care notifications to patients and providers via email (Resend) and SMS (Twilio).</li>
            <li>Sync clinical data with integrated EHR systems (Charm Health) as configured by your practice.</li>
            <li>Process payments and convenience fees via Square.</li>
            <li>Monitor platform security and investigate unauthorized access.</li>
            <li>Improve platform features and performance.</li>
          </ul>
          <p>We do not sell PHI or provider information to third parties. We do not use PHI for marketing purposes.</p>
        </Section>

        <Section title="4. Sub-Processors and Integrations">
          <p>GoRoam Health shares data with the following sub-processors as necessary to operate the Platform. Each is subject to contractual data protection obligations:</p>
          <ul>
            <li><strong>Amazon Web Services (AWS)</strong> — authentication (Cognito) and cloud infrastructure. US-based.</li>
            <li><strong>Neon</strong> — PostgreSQL database hosting. Data stored in the United States.</li>
            <li><strong>Vercel</strong> — Platform hosting and edge infrastructure.</li>
            <li><strong>Charm Health</strong> — EHR integration for patient record synchronization.</li>
            <li><strong>DoseSpot / Surescripts</strong> — Electronic prescribing network. Surescripts is a certified e-prescribing network subject to its own regulatory compliance requirements.</li>
            <li><strong>Resend</strong> — Transactional email delivery.</li>
            <li><strong>Twilio</strong> — SMS notifications.</li>
            <li><strong>Square</strong> — Payment processing for patient convenience fees.</li>
            <li><strong>Google Maps</strong> — Distance calculation for convenience fee pricing.</li>
          </ul>
        </Section>

        <Section title="5. HIPAA Safeguards">
          <p>GoRoam Health implements the following safeguards to protect PHI as required under the HIPAA Security Rule:</p>
          <ul>
            <li><strong>Encryption in transit:</strong> All data transmitted between users and the Platform uses TLS (Transport Layer Security).</li>
            <li><strong>Encryption at rest:</strong> PHI stored in our database is encrypted at rest.</li>
            <li><strong>Access controls:</strong> Role-based access ensures providers and staff can only access records within their authorized scope.</li>
            <li><strong>Audit logging:</strong> System access and data modifications are logged for security review.</li>
            <li><strong>Minimum necessary:</strong> GoRoam Health accesses PHI only as necessary to perform Platform services.</li>
          </ul>
        </Section>

        <Section title="6. Data Retention">
          <p>Patient records and clinical data are retained for the duration of your practice's active subscription with GoRoam Health. Following subscription cancellation:</p>
          <ul>
            <li>Practice data is retained for <strong>90 days</strong> from the cancellation effective date to allow data export.</li>
            <li>After 90 days, data is permanently deleted from GoRoam Health's systems.</li>
            <li>Your practice is responsible for exporting any records needed for compliance with state medical record retention laws before cancellation.</li>
          </ul>
        </Section>

        <Section title="7. Patient Rights Under HIPAA">
          <p>GoRoam Health processes PHI on behalf of your practice. Patient rights under HIPAA — including the right to access, amend, or request an accounting of disclosures of their PHI — must be directed to and fulfilled by your practice as the Covered Entity. GoRoam Health will assist your practice in fulfilling these obligations as required under your BAA.</p>
        </Section>

        <Section title="8. Breach Notification">
          <p>In the event of a breach of unsecured PHI, GoRoam Health will notify your practice without unreasonable delay and within the timeframe required by HIPAA. Your practice, as the Covered Entity, is responsible for notifying affected patients and HHS as required by the HIPAA Breach Notification Rule.</p>
        </Section>

        <Section title="9. Governing Law">
          <p>This Privacy Policy is governed by the laws of the State of South Carolina and applicable federal law, including HIPAA. Disputes shall be subject to the exclusive jurisdiction of the courts of York County, South Carolina.</p>
        </Section>

        <Section title="10. Changes to This Policy">
          <p>GoRoam Health may update this Privacy Policy at any time. Material changes will be communicated by email or in-platform notice at least 14 days before the effective date.</p>
        </Section>

        <Section title="11. Contact">
          <p>For privacy questions, data requests, or to report a suspected breach:</p>
          <p>
            GoRoam Health, LLC<br />
            1832 Marthas Vineyard Road, York, SC 29745<br />
            <a href="mailto:support@goroam.health" className="text-[#7F77DD] hover:underline">support@goroam.health</a>
          </p>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-9">
      <h2 className="text-[17px] font-semibold text-[#1A1A2E] mb-3">{title}</h2>
      <div className="text-[14px] text-[#444] leading-relaxed flex flex-col gap-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5">
        {children}
      </div>
    </div>
  )
}
