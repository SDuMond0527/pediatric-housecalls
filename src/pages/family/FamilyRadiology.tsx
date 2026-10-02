import { Activity } from 'lucide-react'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { PatientReportsSection } from '../../components/PatientReportsSection'

export function FamilyRadiology() {
  const { children } = useFamilyAuth()
  const multiChild = (children?.length ?? 0) > 1

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-[22px] font-semibold text-[#1A1A2E]">Radiology reports</h1>
        <p className="text-[13px] text-[#1A1A2E] mt-1">
          Upload x-ray or imaging reports here so your provider has them on file. You can also view any reports uploaded by our team.
        </p>
      </div>

      {(!children || children.length === 0) && (
        <div className="text-center py-16">
          <Activity size={32} className="text-[#E8E8E4] mx-auto mb-3" />
          <div className="text-[14px] text-[#1A1A2E]">No children on file yet.</div>
        </div>
      )}

      <div className="space-y-6">
        {(children ?? []).map(child => (
          <div key={child.id}>
            {multiChild && (
              <div className="text-[13px] font-semibold text-[#7F77DD] mb-2">
                {[child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label}
              </div>
            )}
            <PatientReportsSection childId={child.id} kind="radiology" role="family" />
          </div>
        ))}
      </div>
    </div>
  )
}
