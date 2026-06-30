import { Link } from 'react-router-dom'
import { PracticeLogo } from '../lib/practice'

export function Terms() {
  return (
    <div className="min-h-screen bg-[#FAFAF8]" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-5 text-center">
        <PracticeLogo className="h-16 w-auto mx-auto mb-2" />
        <div className="text-[13px] text-[#999]">Provider Portal · <Link to="/login" className="text-[#7F77DD] hover:underline">Back to login</Link></div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12 pb-20">
        <h1 className="text-3xl font-semibold text-[#1A1A2E] mb-2">Terms of Service</h1>
        <p className="text-[13px] text-[#999] mb-10">Effective Date: July 1, 2026 · Last Updated: June 30, 2026</p>

        <Section title="1. Agreement to Terms">
          <p>These Terms of Service ("Terms") govern your access to and use of the GoRoam Health provider platform ("Platform"), operated by GoRoam Health, LLC ("GoRoam Health," "we," "us," or "our"). By accessing or using the Platform, you ("Provider," "Practice," or "User") agree to be bound by these Terms.</p>
          <p>GoRoam Health, LLC is a limited liability company registered in South Carolina, with a principal address of 1832 Marthas Vineyard Road, York, SC 29745.</p>
        </Section>

        <Section title="2. Platform Description">
          <p>The GoRoam Health Platform is a software-as-a-service solution designed for licensed medical practices providing house call pediatric care. Features include appointment scheduling and management, a family patient portal, encounter documentation, electronic health record (EHR) integration, insurance claims management, electronic prescribing (e-prescribing) via integration with DoseSpot and the Surescripts network, analytics, and care coordination tools.</p>
        </Section>

        <Section title="3. Eligibility and Authorized Users">
          <p>Access to the Platform is limited to:</p>
          <ul>
            <li>Licensed healthcare providers (physicians, nurse practitioners, and other credentialed clinicians) who are authorized by their practice administrator.</li>
            <li>Practice administrative staff authorized by the practice administrator.</li>
          </ul>
          <p>You represent and warrant that you are a licensed healthcare professional or authorized staff member of a licensed medical practice, and that your use of the Platform complies with all applicable professional licensing requirements and regulations.</p>
        </Section>

        <Section title="4. HIPAA Compliance and Business Associate Agreement">
          <p>GoRoam Health acts as a Business Associate under the Health Insurance Portability and Accountability Act of 1996 (HIPAA) and its implementing regulations, including the HITECH Act. A Business Associate Agreement (BAA) must be executed between GoRoam Health and your practice prior to any use of the Platform that involves Protected Health Information (PHI).</p>
          <p>As a Covered Entity, your practice is responsible for:</p>
          <ul>
            <li>Using the Platform in a manner consistent with HIPAA requirements.</li>
            <li>Ensuring that authorized users are trained on HIPAA obligations.</li>
            <li>Promptly reporting any suspected breach of PHI to GoRoam Health.</li>
            <li>Maintaining appropriate safeguards for login credentials.</li>
          </ul>
          <p>GoRoam Health implements administrative, physical, and technical safeguards to protect PHI as required under HIPAA, including encryption of data in transit and at rest, access controls, and audit logging.</p>
        </Section>

        <Section title="5. Electronic Prescribing (E-Prescribing)">
          <p>The Platform integrates with DoseSpot and the Surescripts network to enable electronic prescribing of medications, including controlled substances where applicable. By using the e-prescribing feature, you agree to:</p>
          <ul>
            <li>Comply with all applicable federal and state laws governing electronic prescribing, including DEA regulations for controlled substance prescribing (EPCS).</li>
            <li>Comply with Surescripts' network policies and terms of use.</li>
            <li>Only prescribe within your scope of licensure and clinical judgment.</li>
            <li>Maintain accurate prescriber credentials and NPI information within the Platform.</li>
            <li>Not use e-prescribing functionality for any unlawful purpose or in violation of applicable prescribing laws.</li>
          </ul>
          <p>GoRoam Health does not practice medicine and does not supervise or validate clinical prescribing decisions. All prescribing decisions are solely the responsibility of the licensed prescriber.</p>
        </Section>

        <Section title="6. Provider Responsibilities">
          <p>You agree to:</p>
          <ul>
            <li>Keep your login credentials confidential and not share them with any other person.</li>
            <li>Immediately notify your practice administrator if you suspect unauthorized access to your account.</li>
            <li>Ensure all clinical documentation entered into the Platform is accurate and complete to the best of your knowledge.</li>
            <li>Use the Platform only for lawful purposes consistent with applicable healthcare laws and regulations.</li>
            <li>Not attempt to access patient records outside your authorized scope of care.</li>
          </ul>
        </Section>

        <Section title="7. Intellectual Property">
          <p>GoRoam Health retains all right, title, and interest in the Platform, including all software, designs, workflows, and content provided by GoRoam Health. Your practice retains ownership of all clinical data and patient records entered into the Platform.</p>
          <p>You receive a limited, non-exclusive, non-transferable license to use the Platform for authorized clinical and administrative purposes during the term of your practice's active subscription.</p>
        </Section>

        <Section title="8. Disclaimer of Warranties">
          <p>The Platform is provided "as is" and "as available." GoRoam Health makes no warranties, express or implied, regarding the Platform's fitness for any particular clinical purpose, uninterrupted availability, or freedom from errors. GoRoam Health does not warrant the accuracy of any third-party data or integrations, including pharmacy benefit information or drug interaction alerts provided via DoseSpot or Surescripts.</p>
          <p>Clinical decision-making remains solely the responsibility of the licensed provider.</p>
        </Section>

        <Section title="9. Limitation of Liability">
          <p>To the maximum extent permitted by applicable law, GoRoam Health shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Platform, including any adverse patient outcomes resulting from clinical decisions made using the Platform. GoRoam Health's total cumulative liability shall not exceed the fees paid by your practice in the three (3) months preceding the event giving rise to the claim.</p>
        </Section>

        <Section title="10. Governing Law">
          <p>These Terms are governed by the laws of the State of South Carolina, without regard to its conflict of law principles. Disputes shall be subject to the exclusive jurisdiction of the state and federal courts of York County, South Carolina.</p>
        </Section>

        <Section title="11. Modifications">
          <p>GoRoam Health may update these Terms at any time. Material changes will be communicated by email or in-platform notice at least 14 days before taking effect. Continued use of the Platform after the effective date constitutes acceptance of the revised Terms.</p>
        </Section>

        <Section title="12. Contact">
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
