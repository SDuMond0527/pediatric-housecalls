// Small help footer rendered at the bottom of every signup / login /
// password-reset / setup page. Gives parents a direct human contact
// (Pam) so they never get stuck at an auth or booking step with no
// way to reach us. Sara 2026-09-25.
export function AuthHelpFooter() {
  return (
    <p className="text-center text-[12px] text-[#1A1A2E] mt-6 leading-relaxed">
      Having technical issues logging in or completing your booking?{' '}
      <a href="sms:+17045604169" className="text-[#7F77DD] font-medium hover:underline whitespace-nowrap">
        Text us at 704-560-4169
      </a>
    </p>
  )
}
