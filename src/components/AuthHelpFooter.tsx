// Small help footer rendered at the bottom of every signup / login /
// password-reset / setup page. Two contact lines so parents never get
// stuck at an auth or booking step with no way to reach us:
//   • General questions (clinical / scheduling) → 704-315-7697
//   • Technical issues (login / booking)        → 704-560-4169
// Sara 2026-09-25, general-questions line added 2026-11-20.
export function AuthHelpFooter() {
  return (
    <div className="text-center mt-6 space-y-1">
      <p className="text-[12px] text-[#1A1A2E] leading-relaxed">
        For general questions{' '}
        <a href="sms:+17043157697" className="text-[#7F77DD] font-medium hover:underline whitespace-nowrap">
          text 704-315-7697
        </a>
      </p>
      <p className="text-[12px] text-[#1A1A2E] leading-relaxed">
        Having technical issues logging in or completing your booking?{' '}
        <a href="sms:+17045604169" className="text-[#7F77DD] font-medium hover:underline whitespace-nowrap">
          Text us at 704-560-4169
        </a>
      </p>
    </div>
  )
}
