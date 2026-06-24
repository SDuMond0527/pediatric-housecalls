import type { VisitType } from '../types'

export const VISIT_TYPES: Record<VisitType, { badge: string; color: string; textColor: string }> = {
  'In-home sick visit':               { badge: 'Sick visit',     color: '#EEEDFE', textColor: '#3C3489' },
  'Video telemedicine':               { badge: 'Telemedicine',   color: '#E1F5EE', textColor: '#085041' },
  'Sports physical':                  { badge: 'Sports physical',color: '#FAEEDA', textColor: '#633806' },
  'CMA + telemedicine':               { badge: 'CMA + tele',     color: '#E6F1FB', textColor: '#0C447C' },
  'Text visit':                       { badge: 'Text visit',      color: '#FBEAF0', textColor: '#993556' },
  'In-home IV fluids':                { badge: 'IV fluids',       color: '#E1F5EE', textColor: '#085041' },
  'In-home CPR class (Heartsaver)':   { badge: 'CPR Heartsaver',  color: '#FDEDEC', textColor: '#922B21' },
  'In-home CPR class (BLS)':          { badge: 'CPR BLS',         color: '#FDEDEC', textColor: '#922B21' },
}

// Duration in minutes for each visit type
export const VISIT_DURATIONS: Record<string, number> = {
  'In-home sick visit':             60,
  'Sports physical':                60,
  'CMA + telemedicine':             60,
  'In-home IV fluids':              90,
  'Video telemedicine':             30,
  'Text visit':                     15,
  'In-home CPR class (Heartsaver)': 180,
  'In-home CPR class (BLS)':        180,
}

// Minimum lead time (minutes) required before booking same-day
export const LEAD_MINUTES: Record<string, number> = {
  'In-home sick visit':             60,
  'Sports physical':                60,
  'CMA + telemedicine':             60,
  'In-home IV fluids':              60,
  'Video telemedicine':             30,
  'Text visit':                     30,
  'In-home CPR class (Heartsaver)': 120,
  'In-home CPR class (BLS)':        120,
}

export const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const DEFAULT_AVAILABILITY = DAYS_OF_WEEK.map((_day, i) => ({
  day_of_week: i,
  is_active: i >= 1 && i <= 5,
  start_time: '08:00',
  end_time: '17:00',
}))

export const ALL_ZONES = [
  'Huntersville / Davidson / Cornelius',
  'Concord', 'Kannapolis', 'Harrisburg', 'University', 'Mooresville', 'Oakdale',
  'Cotswold / SouthPark', 'Ballantyne / Providence', 'Matthews',
  'Waxhaw / Weddington / Marvin', 'Indianland',
  'York / Lake Wylie / Clover', 'Fort Mill', 'Rock Hill',
  'Greater Raleigh',
  'Leesburg area', 'Great Falls', 'Reston', 'Gainesville',
  'Ashburn / Sterling', 'Chantilly / Centreville',
]

export const PROVIDERS_SEED = [
  { name: 'Dr. Sara DuMond',      role: 'MD',  initials: 'SD',  zones: ['York / Lake Wylie / Clover','Fort Mill','Rock Hill','Indianland'],                                                                        states: ['NC','SC','VA'], avatar_color: '#EEEDFE', avatar_text_color: '#3C3489' },
  { name: 'Dr. Rebecca Santos',   role: 'MD',  initials: 'RS',  zones: ['Leesburg area','Great Falls','Reston','Gainesville','Ashburn / Sterling','Chantilly / Centreville'],                                      states: ['VA'],           avatar_color: '#E1F5EE', avatar_text_color: '#085041' },
  { name: 'Dr. Nina Niu',         role: 'MD',  initials: 'NN',  zones: ['Leesburg area','Great Falls','Reston','Gainesville','Ashburn / Sterling','Chantilly / Centreville'],                                      states: ['VA'],           avatar_color: '#FAEEDA', avatar_text_color: '#633806' },
  { name: 'Dr. Mary Garrison',    role: 'MD',  initials: 'MG',  zones: ['Huntersville / Davidson / Cornelius','Concord','Kannapolis','Harrisburg','University'],                                                    states: ['NC'],           avatar_color: '#E6F1FB', avatar_text_color: '#0C447C' },
  { name: 'Dr. Shaoleen Daly',    role: 'MD',  initials: 'SD2', zones: ['Huntersville / Davidson / Cornelius','Concord','Kannapolis','Harrisburg','University','Oakdale'],                                          states: ['NC'],           avatar_color: '#EEEDFE', avatar_text_color: '#534AB7' },
  { name: 'Melissa Jesse',        role: 'PNP', initials: 'MJ',  zones: ['Cotswold / SouthPark'],                                                                                                                   states: ['NC'],           avatar_color: '#E1F5EE', avatar_text_color: '#085041' },
  { name: 'Becca Jones',          role: 'PNP', initials: 'BJ',  zones: ['Cotswold / SouthPark','Ballantyne / Providence','Matthews'],                                                                               states: ['NC'],           avatar_color: '#FAEEDA', avatar_text_color: '#633806' },
  { name: 'Allison Berger',       role: 'PNP', initials: 'AB',  zones: ['Waxhaw / Weddington / Marvin','Indianland'],                                                                                              states: ['NC','SC'],      avatar_color: '#E6F1FB', avatar_text_color: '#0C447C' },
  { name: 'Megan Heilemann',      role: 'PNP', initials: 'MH',  zones: ['Huntersville / Davidson / Cornelius','Concord','University','Mooresville'],                                                                states: ['NC'],           avatar_color: '#EEEDFE', avatar_text_color: '#534AB7' },
  { name: 'Samantha Casnettie',   role: 'PNP', initials: 'SC',  zones: ['Cotswold / SouthPark','Ballantyne / Providence','Matthews'],                                                                               states: ['NC'],           avatar_color: '#E6F1FB', avatar_text_color: '#0C447C' },
  { name: 'Amber Taylor',         role: 'CMA', initials: 'AT',  zones: ['Huntersville / Davidson / Cornelius','Concord','Kannapolis','Harrisburg','University'],                                                    states: ['NC'],           avatar_color: '#FAEEDA', avatar_text_color: '#633806' },
  { name: 'Shondalyn Robertson',  role: 'CMA', initials: 'SR',  zones: ['Greater Raleigh'],                                                                                                                        states: ['NC'],           avatar_color: '#EEEDFE', avatar_text_color: '#3C3489' },
  { name: 'Sonya Hampton',        role: 'CMA', initials: 'SH',  zones: ['Greater Raleigh'],                                                                                                                        states: ['NC'],           avatar_color: '#E1F5EE', avatar_text_color: '#085041' },
  { name: 'Meghan Trimble',       role: 'RN',  initials: 'MT',  zones: ['Huntersville / Davidson / Cornelius','Concord','Kannapolis','Harrisburg','University','Cotswold / SouthPark','Ballantyne / Providence','Matthews','Mooresville','Waxhaw / Weddington / Marvin','Oakdale'], states: ['NC'], avatar_color: '#FAEEDA', avatar_text_color: '#633806' },
  { name: 'Karen Hinkle',         role: 'RN',  initials: 'KH',  zones: ['Huntersville / Davidson / Cornelius','Concord','Kannapolis','Harrisburg','University','Cotswold / SouthPark','Ballantyne / Providence','Matthews','Mooresville','Waxhaw / Weddington / Marvin','Oakdale'], states: ['NC'], avatar_color: '#E6F1FB', avatar_text_color: '#0C447C' },
  { name: 'Cara Robertson',       role: 'RN',  initials: 'CR',  zones: ['York / Lake Wylie / Clover','Indianland','Fort Mill','Rock Hill'],                                                                        states: ['NC','SC'],      avatar_color: '#EEEDFE', avatar_text_color: '#3C3489' },
]
