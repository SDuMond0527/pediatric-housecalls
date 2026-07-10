import { Link } from 'react-router-dom'

const FAQS = [
  {
    q: 'What is GoRoam Health?',
    a: 'GoRoam Health is a clinical operations platform built for licensed medical practices that provide pediatric house call services. The platform supports appointment scheduling, encounter documentation, insurance claims management, electronic health record (EHR) integration, patient communication, and electronic prescribing — all in one place for providers seeing patients in the home.',
  },
  {
    q: 'Who are GoRoam Health\'s customers?',
    a: 'GoRoam Health serves licensed pediatric medical practices, including physicians (MDs) and nurse practitioners (PNPs), who deliver in-home and telehealth care to pediatric patients. Practice administrators and clinical staff use the platform to coordinate scheduling, documentation, and care delivery.',
  },
  {
    q: 'What is e-prescribing and how does GoRoam Health use it?',
    a: 'Electronic prescribing (e-prescribing) is the digital transmission of a prescription from a licensed prescriber directly to a pharmacy, replacing handwritten or fax-based prescriptions. GoRoam Health integrates with DoseSpot, a Surescripts-certified electronic prescribing platform, enabling providers to send prescriptions electronically to the patient\'s chosen pharmacy at the point of care — whether during an in-home visit or after a telehealth encounter.',
  },
  {
    q: 'Does the prescriber choose the medication?',
    a: 'Yes. All prescribing decisions — including the choice of medication, dosage, and instructions — are made solely by the licensed prescriber based on their clinical judgment and the individual patient\'s needs. GoRoam Health and DoseSpot do not influence, restrict, or suggest specific medications. The platform is a transmission tool only; clinical decision-making is entirely the prescriber\'s responsibility.',
  },
  {
    q: 'Does the patient get to choose their own pharmacy?',
    a: 'Yes. Patients designate their preferred pharmacy during account setup or at the time of booking. The prescribing provider sends the prescription to the patient\'s chosen pharmacy. Patients may update their preferred pharmacy at any time. GoRoam Health does not restrict patient pharmacy choice.',
  },
  {
    q: 'Which pharmacies can receive prescriptions sent through GoRoam Health?',
    a: 'Prescriptions are transmitted via DoseSpot and the Surescripts network, which connects to over 60,000 retail, mail-order, and specialty pharmacies nationwide — including major chains such as CVS, Walgreens, Rite Aid, and Walmart as well as independent community pharmacies. Patients may choose any participating pharmacy in the Surescripts network.',
  },
  {
    q: 'Can controlled substances be prescribed electronically?',
    a: 'Electronic prescribing for controlled substances (EPCS) is subject to DEA regulations and applicable state law. Where permitted, GoRoam Health\'s integration with DoseSpot supports EPCS for properly credentialed prescribers who have completed the required identity proofing and two-factor authentication processes mandated by the DEA.',
  },
  {
    q: 'Does GoRoam Health have any financial relationship with pharmaceutical companies or pharmacies?',
    a: 'No. GoRoam Health has no financial relationship with any pharmaceutical manufacturer, pharmacy chain, pharmacy benefit manager, or drug company. The platform receives no compensation based on which medications are prescribed or which pharmacies are selected. Prescribers and patients make those choices independently.',
  },
  {
    q: 'How is prescription and patient data protected?',
    a: 'GoRoam Health is a HIPAA-compliant platform that processes Protected Health Information (PHI) under a Business Associate Agreement (BAA) with each practice. All data is encrypted in transit (TLS) and at rest. Prescription data transmitted through DoseSpot and the Surescripts network is subject to Surescripts\' certified security and compliance requirements.',
  },
  {
    q: 'What is Surescripts?',
    a: 'Surescripts is the nation\'s largest health information network, operating the infrastructure that enables electronic prescribing between licensed prescribers and pharmacies across the United States. Surescripts is certified by the DEA and meets national standards for prescription data transmission accuracy and security.',
  },
  {
    q: 'What is DoseSpot?',
    a: 'DoseSpot is a Surescripts-certified electronic prescribing software provider. GoRoam Health integrates DoseSpot into the provider portal to enable licensed prescribers to generate and transmit electronic prescriptions without leaving their existing workflow.',
  },
  {
    q: 'Where is GoRoam Health available?',
    a: 'GoRoam Health currently supports practices operating in North Carolina, South Carolina, and Virginia, with expansion planned. The e-prescribing functionality via DoseSpot and Surescripts supports prescription transmission to participating pharmacies nationwide.',
  },
  {
    q: 'How do I contact GoRoam Health?',
    a: 'You can reach us at support@goroam.health or by mail at GoRoam Health, LLC, 1832 Marthas Vineyard Road, York, SC 29745.',
  },
]

export function FAQ() {
  return (
    <div className="min-h-screen bg-[#FAFAF8]" style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-5 flex items-center justify-between">
        <Link to="/" className="text-xl font-semibold text-[#1A1A2E] hover:opacity-80 transition-opacity">GoRoam Health</Link>
        <Link to="/login" className="text-[13px] text-[#7F77DD] hover:underline">Provider login</Link>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12 pb-20">
        <h1 className="text-3xl font-semibold text-[#1A1A2E] mb-2">Frequently Asked Questions</h1>
        <p className="text-[14px] text-[#999] mb-10">About GoRoam Health and our e-prescribing platform</p>

        <div className="space-y-6">
          {FAQS.map(({ q, a }) => (
            <div key={q} className="bg-white border border-[#E8E8E4] rounded-xl px-6 py-5">
              <h2 className="text-[15px] font-semibold text-[#1A1A2E] mb-2">{q}</h2>
              <p className="text-[14px] text-[#444] leading-relaxed">{a}</p>
            </div>
          ))}
        </div>
      </div>

      <footer className="border-t border-[#E8E8E4] bg-white px-6 py-6 text-center text-[12px] text-[#999]">
        <div className="flex justify-center gap-6 mb-2">
          <Link to="/terms" className="hover:text-[#7F77DD] transition-colors">Terms of Service</Link>
          <Link to="/privacy" className="hover:text-[#7F77DD] transition-colors">Privacy Policy</Link>
          <Link to="/faq" className="hover:text-[#7F77DD] transition-colors">FAQ</Link>
        </div>
        <div>© {new Date().getFullYear()} GoRoam Health, LLC · support@goroam.health · York, SC 29745</div>
      </footer>
    </div>
  )
}
