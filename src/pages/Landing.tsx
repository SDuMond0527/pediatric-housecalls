import { Link } from 'react-router-dom'
import { Shield, MapPin, Smartphone, ClipboardList, Pill, Building2 } from 'lucide-react'

export function Landing() {
  return (
    <div className="min-h-screen bg-[#FAFAF8]" style={{ fontFamily: "'DM Sans', sans-serif" }}>

      {/* Header */}
      <header className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="text-xl font-semibold text-[#1A1A2E]">GoRoam Health</div>
        <Link
          to="/login"
          className="bg-[#7F77DD] text-white text-[13px] font-medium px-4 py-2 rounded-lg hover:bg-[#6B63C8] transition-colors"
        >
          Provider login
        </Link>
      </header>

      {/* Hero */}
      <section className="bg-white border-b border-[#E8E8E4] px-6 py-16 text-center">
        <div className="max-w-2xl mx-auto">
          <div className="inline-block bg-[#EEEDFE] text-[#7F77DD] text-[12px] font-medium px-3 py-1 rounded-full mb-5">
            Pediatric House Call Platform
          </div>
          <h1 className="text-4xl font-semibold text-[#1A1A2E] leading-tight mb-4">
            Clinical operations software for pediatric house call practices
          </h1>
          <p className="text-[16px] text-[#666] leading-relaxed mb-8">
            GoRoam Health gives pediatric practices everything they need to coordinate in-home and telehealth care — scheduling, documentation, claims, EHR integration, and electronic prescribing — in a single platform built for providers on the move.
          </p>
          <div className="flex justify-center gap-3 flex-wrap">
            <Link
              to="/login"
              className="bg-[#7F77DD] text-white text-[14px] font-medium px-5 py-2.5 rounded-lg hover:bg-[#6B63C8] transition-colors"
            >
              Provider login
            </Link>
            <a
              href="mailto:support@goroam.health"
              className="border border-[#E8E8E4] text-[#1A1A2E] text-[14px] font-medium px-5 py-2.5 rounded-lg hover:bg-[#F5F5F3] transition-colors"
            >
              Contact us
            </a>
          </div>
        </div>
      </section>

      {/* Business Model */}
      <section className="px-6 py-14 max-w-4xl mx-auto">
        <h2 className="text-[22px] font-semibold text-[#1A1A2E] mb-2">Our business model</h2>
        <p className="text-[14px] text-[#666] mb-8 leading-relaxed">
          GoRoam Health operates as a software-as-a-service (SaaS) platform licensed to licensed medical practices. Practices pay a subscription fee to access the platform for their providers and administrative staff. GoRoam Health does not employ clinicians, does not provide medical care, and does not generate revenue from prescriptions, pharmacy relationships, or pharmaceutical partnerships.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              icon: <Building2 size={18} className="text-[#7F77DD]" />,
              title: 'Practice-licensed SaaS',
              body: 'Medical practices subscribe to the platform. Pricing is based on practice size and features — not volume of prescriptions or clinical activity.',
            },
            {
              icon: <Shield size={18} className="text-[#1D9E75]" />,
              title: 'HIPAA-compliant infrastructure',
              body: 'GoRoam Health acts as a Business Associate under HIPAA, with BAAs in place for all data sub-processors. PHI is encrypted in transit and at rest.',
            },
            {
              icon: <Pill size={18} className="text-[#EF9F27]" />,
              title: 'No pharmaceutical relationships',
              body: 'GoRoam Health has no financial relationships with pharmaceutical manufacturers, pharmacies, or pharmacy benefit managers.',
            },
          ].map(({ icon, title, body }) => (
            <div key={title} className="bg-white border border-[#E8E8E4] rounded-xl p-5">
              <div className="mb-3">{icon}</div>
              <div className="text-[14px] font-semibold text-[#1A1A2E] mb-1.5">{title}</div>
              <div className="text-[13px] text-[#666] leading-relaxed">{body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Who We Serve */}
      <section className="bg-white border-y border-[#E8E8E4] px-6 py-14">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-[22px] font-semibold text-[#1A1A2E] mb-2">Who we serve</h2>
          <p className="text-[14px] text-[#666] mb-8 leading-relaxed">
            GoRoam Health is purpose-built for licensed pediatric medical practices that deliver care in patients' homes. Our customers are small-to-mid-size practices operating across the southeastern and mid-Atlantic United States.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { label: 'Provider types', value: 'Physicians (MD), Nurse Practitioners (PNP), Clinical Medical Assistants (CMA), Registered Nurses (RN)' },
              { label: 'Care settings', value: 'In-home sick visits, in-home IV therapy, sports physicals, telehealth video visits, CMA + telemedicine hybrid visits' },
              { label: 'Patient population', value: 'Pediatric patients (infants through adolescents) seen in the home by their practice\'s assigned provider' },
              { label: 'Service areas', value: 'Currently serving practices in North Carolina, South Carolina, and Virginia, with expansion underway' },
            ].map(({ label, value }) => (
              <div key={label} className="border border-[#E8E8E4] rounded-xl p-5">
                <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-1.5">{label}</div>
                <div className="text-[14px] text-[#333] leading-relaxed">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* E-Prescribing */}
      <section className="px-6 py-14 max-w-4xl mx-auto">
        <h2 className="text-[22px] font-semibold text-[#1A1A2E] mb-2">Electronic prescribing</h2>
        <p className="text-[14px] text-[#666] mb-8 leading-relaxed">
          GoRoam Health integrates with DoseSpot, a Surescripts-certified e-prescribing platform, to enable licensed providers to transmit prescriptions electronically to the patient's pharmacy of choice — directly from within the GoRoam Health provider portal.
        </p>

        {/* Workflow callout — Surescripts requires this explicitly */}
        <div className="bg-[#EEEDFE] border border-[#C8C4F5] rounded-xl p-6 mb-8">
          <div className="text-[13px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-4">Prescribing workflow</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <div className="text-[14px] font-semibold text-[#1A1A2E] mb-1.5">Prescriber choice of medication</div>
              <div className="text-[13px] text-[#444] leading-relaxed">
                The licensed prescriber (MD or PNP) makes all clinical decisions independently — including which medication to prescribe, the dosage, and the directions. GoRoam Health and DoseSpot do not influence, restrict, or suggest specific medications. Prescribing decisions are solely the responsibility of the licensed provider.
              </div>
            </div>
            <div>
              <div className="text-[14px] font-semibold text-[#1A1A2E] mb-1.5">Patient choice of pharmacy</div>
              <div className="text-[13px] text-[#444] leading-relaxed">
                Patients select their preferred pharmacy when they create their account or at the time of booking. The provider routes the prescription to that pharmacy. Patients may update their pharmacy preference at any time. GoRoam Health does not restrict or influence patient pharmacy choice.
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              step: '1',
              title: 'Provider sees patient',
              body: 'Provider completes the in-home or telehealth visit and documents the encounter in GoRoam Health.',
            },
            {
              step: '2',
              title: 'Provider prescribes',
              body: 'Provider accesses e-prescribing within the portal and selects the medication and dosage based on clinical judgment.',
            },
            {
              step: '3',
              title: 'Prescription transmitted',
              body: 'The prescription is sent electronically via DoseSpot and the Surescripts network to the patient\'s chosen pharmacy.',
            },
          ].map(({ step, title, body }) => (
            <div key={step} className="bg-white border border-[#E8E8E4] rounded-xl p-5">
              <div className="w-7 h-7 rounded-full bg-[#EEEDFE] text-[#7F77DD] text-[13px] font-semibold flex items-center justify-center mb-3">{step}</div>
              <div className="text-[14px] font-semibold text-[#1A1A2E] mb-1.5">{title}</div>
              <div className="text-[13px] text-[#666] leading-relaxed">{body}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 bg-white border border-[#E8E8E4] rounded-xl p-5">
          <div className="text-[13px] font-semibold text-[#1A1A2E] mb-1.5">Pharmacy network</div>
          <div className="text-[13px] text-[#666] leading-relaxed">
            Prescriptions are transmitted via the Surescripts network, which connects to over 60,000 pharmacies nationwide — including CVS, Walgreens, Rite Aid, Walmart, and independent community pharmacies. Electronic prescribing for controlled substances (EPCS) is supported for eligible, DEA-credentialed prescribers in compliance with applicable federal and state law.
          </div>
        </div>
      </section>

      {/* Platform Screenshots */}
      <section className="bg-white border-y border-[#E8E8E4] px-6 py-14">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-[22px] font-semibold text-[#1A1A2E] mb-2">Platform overview</h2>
          <p className="text-[14px] text-[#666] mb-8 leading-relaxed">
            GoRoam Health gives providers and practice administrators a unified view of scheduling, patients, and clinical activity.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { label: 'Provider schedule — daily view', file: '/screenshots/schedule.png' },
              { label: 'Provider schedule — week view', file: '/screenshots/weekview.png' },
              { label: 'Admin schedule', file: '/screenshots/dailyschedule.png' },
              { label: 'Reports & analytics', file: '/screenshots/reports.png' },
            ].map(({ label, file }) => (
              <div key={label} className="border border-[#E8E8E4] rounded-xl overflow-hidden">
                <img
                  src={file}
                  alt={label}
                  className="w-full h-48 object-cover object-top bg-[#F0F0F8]"
                  onError={e => {
                    const el = e.currentTarget
                    el.style.display = 'none'
                    el.nextElementSibling?.classList.remove('hidden')
                  }}
                />
                <div className="hidden h-48 bg-[#F5F5F3] flex items-center justify-center">
                  <span className="text-[13px] text-[#999]">{label}</span>
                </div>
                <div className="px-4 py-2.5 border-t border-[#E8E8E4] text-[12px] text-[#666]">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="px-6 py-14 max-w-4xl mx-auto">
        <h2 className="text-[22px] font-semibold text-[#1A1A2E] mb-8">Platform features</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { icon: <ClipboardList size={15} className="text-[#7F77DD]" />, label: 'Appointment scheduling and management' },
            { icon: <Smartphone size={15} className="text-[#7F77DD]" />, label: 'Family patient portal with online booking' },
            { icon: <ClipboardList size={15} className="text-[#7F77DD]" />, label: 'Encounter documentation and clinical notes' },
            { icon: <Shield size={15} className="text-[#7F77DD]" />, label: 'EHR integration (Charm Health)' },
            { icon: <Pill size={15} className="text-[#7F77DD]" />, label: 'Electronic prescribing via DoseSpot / Surescripts' },
            { icon: <Building2 size={15} className="text-[#7F77DD]" />, label: 'Insurance claims management' },
            { icon: <MapPin size={15} className="text-[#7F77DD]" />, label: 'Zone-based provider routing and availability' },
            { icon: <Smartphone size={15} className="text-[#7F77DD]" />, label: 'Automated appointment notifications (email + SMS)' },
          ].map(({ icon, label }) => (
            <div key={label} className="flex items-center gap-3 bg-white border border-[#E8E8E4] rounded-lg px-4 py-3">
              {icon}
              <span className="text-[13px] text-[#333]">{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Contact */}
      <section className="bg-white border-t border-[#E8E8E4] px-6 py-14">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-[22px] font-semibold text-[#1A1A2E] mb-6">Contact</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <div className="text-[13px] font-semibold text-[#999] uppercase tracking-wider mb-2">General inquiries</div>
              <div className="text-[14px] text-[#333] mb-1">GoRoam Health, LLC</div>
              <div className="text-[14px] text-[#333] mb-1">1832 Marthas Vineyard Road</div>
              <div className="text-[14px] text-[#333] mb-3">York, SC 29745</div>
              <a href="mailto:support@goroam.health" className="text-[14px] text-[#7F77DD] hover:underline">
                support@goroam.health
              </a>
            </div>
            <div>
              <div className="text-[13px] font-semibold text-[#999] uppercase tracking-wider mb-2">Legal &amp; compliance</div>
              <div className="text-[14px] text-[#555] leading-relaxed mb-3">
                For privacy questions, data requests, HIPAA inquiries, or to report a suspected breach, contact us at the address above.
              </div>
              <div className="flex gap-3 flex-wrap">
                <Link to="/terms" className="text-[13px] text-[#7F77DD] hover:underline">Terms of Service</Link>
                <Link to="/privacy" className="text-[13px] text-[#7F77DD] hover:underline">Privacy Policy</Link>
                <Link to="/faq" className="text-[13px] text-[#7F77DD] hover:underline">FAQ</Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#E8E8E4] bg-[#FAFAF8] px-6 py-5 text-center text-[12px] text-[#999]">
        <div className="flex justify-center gap-6 mb-1.5">
          <Link to="/terms" className="hover:text-[#7F77DD] transition-colors">Terms of Service</Link>
          <Link to="/privacy" className="hover:text-[#7F77DD] transition-colors">Privacy Policy</Link>
          <Link to="/faq" className="hover:text-[#7F77DD] transition-colors">FAQ</Link>
        </div>
        <div>© {new Date().getFullYear()} GoRoam Health, LLC · York, SC 29745</div>
      </footer>

    </div>
  )
}
