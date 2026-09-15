// Rotating daily affirmation shown to providers on their Today page and
// to admins in the admin sidebar. One message per day for the whole
// team — rotates at midnight. Add / remove freely; length doesn't
// matter, the modulo handles it.

export const AFFIRMATIONS: string[] = [
  'You are stronger than you think and softer than you know.',
  'Remember you are beautiful, capable, and needed.',
  'A house call from you today is a small act of grace.',
  'You do work that matters. Every visit, every note, every call.',
  "You've got this. And if you don't, that's still okay.",
  'Take up space. You earned every inch of this expertise.',
  'The way you show up for these families is a gift.',
  'Rest is productive. So is joy. So is a decent lunch.',
  'You are not behind. You are exactly where you are.',
  'The care you give is medicine — for them and for you.',
  'Be as gentle with yourself as you are with a sick toddler.',
  'You are a whole person, not a to-do list. Both today.',
  'This job is hard. You are harder. In the best way.',
  'Someone out there is better because of a decision you made.',
  'Your calm in a chaotic moment is a superpower.',
  'You are allowed to feel proud of yourself.',
  'You are not too much. The world is just often too little.',
  'Small wins count. Charting counts. Coffee counts.',
  'You bring your own light — and it is enough.',
  'The families who see you know how lucky they are.',
  'You are worth the same kindness you extend all day.',
  'Rooting for you. Every single visit.',
  'Take one breath just for you before the next patient.',
  "Some days you're the healer. Some days you rest. Both matter.",
  'The little things you do have huge ripples.',
  'You are steady, thoughtful, and kind. That heals people.',
  'Your instincts are good. Trust them today.',
  'Slow is smooth. Smooth is fast. You know the pace.',
  'You are exactly the doctor / provider a scared parent needs.',
  "Whatever today brings — you'll figure it out. You always do.",
  'Compassion looks good on you.',
  "Today's version of 'enough' is enough.",
  'You make the hard stuff look human. That is real skill.',
  'Someone thought of you today with gratitude.',
  'You are the reason a family sleeps easier tonight.',
]

// Same message all day for everyone on the team. Index rotates over
// midnight. Deterministic per-day so shared moments are possible
// ("did you see today's?").
export function dailyAffirmation(): string {
  const startOfYear = new Date(new Date().getFullYear(), 0, 0).getTime()
  const dayIndex = Math.floor((Date.now() - startOfYear) / 86_400_000)
  return AFFIRMATIONS[dayIndex % AFFIRMATIONS.length]
}
