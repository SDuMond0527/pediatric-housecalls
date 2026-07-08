import { VENMO_HANDLE } from './practice'

export const ZIP_TO_STATE: Record<string, string> = {
  '28078':'NC','28036':'NC','28031':'NC','28025':'NC','28027':'NC','28081':'NC','28075':'NC',
  '28117':'NC','28115':'NC','28226':'NC','28270':'NC','28277':'NC','28203':'NC','28204':'NC',
  '28205':'NC','28207':'NC','28209':'NC','28210':'NC','28211':'NC','28173':'NC','28104':'NC',
  '28105':'NC','28106':'NC','28037':'NC','28269':'NC','28262':'NC','28214':'NC','28216':'NC',
  '27601':'NC','27603':'NC','27604':'NC','27605':'NC','27606':'NC','27607':'NC','27608':'NC',
  '27609':'NC','27610':'NC','27612':'NC','27613':'NC','27614':'NC','27615':'NC','27616':'NC',
  '27617':'NC','27540':'NC','27539':'NC',
  '29745':'SC','29710':'SC','29707':'SC','29708':'SC','29715':'SC','29716':'SC','29730':'SC',
  '29731':'SC','29734':'SC',
  '29601':'SC','29602':'SC','29603':'SC','29604':'SC','29605':'SC','29606':'SC','29607':'SC',
  '29608':'SC','29609':'SC','29610':'SC','29611':'SC','29612':'SC','29613':'SC','29614':'SC',
  '29615':'SC','29616':'SC','29617':'SC',
  '29650':'SC','29651':'SC','29652':'SC',
  '20175':'VA','20176':'VA','20158':'VA','20132':'VA','20141':'VA','20197':'VA','20129':'VA',
  '22066':'VA','20190':'VA','20191':'VA','20194':'VA','20155':'VA','20147':'VA','20148':'VA',
  '20164':'VA','20165':'VA','20166':'VA','20105':'VA','20151':'VA','20152':'VA','20171':'VA','20120':'VA',
}

export const ZIP_TO_ZONE: Record<string, string> = {
  '28078':'Huntersville / Davidson / Cornelius','28036':'Huntersville / Davidson / Cornelius',
  '28031':'Huntersville / Davidson / Cornelius','28025':'Concord','28027':'Concord',
  '28081':'Kannapolis','28075':'Harrisburg','28117':'Mooresville','28115':'Mooresville',
  '28226':'Ballantyne / Providence','28270':'Ballantyne / Providence','28277':'Ballantyne / Providence',
  '28203':'Myers Park / Dilworth / Elizabeth / SouthPark / Cotswold','28204':'Myers Park / Dilworth / Elizabeth / SouthPark / Cotswold','28205':'Myers Park / Dilworth / Elizabeth / SouthPark / Cotswold',
  '28207':'Myers Park / Dilworth / Elizabeth / SouthPark / Cotswold','28209':'Myers Park / Dilworth / Elizabeth / SouthPark / Cotswold','28210':'Myers Park / Dilworth / Elizabeth / SouthPark / Cotswold',
  '28211':'Myers Park / Dilworth / Elizabeth / SouthPark / Cotswold','28173':'Waxhaw / Weddington / Marvin',
  '28104':'Matthews','28105':'Matthews','28106':'Matthews',
  '28037':'Denver','28269':'University','28262':'University',
  '28214':'Oakdale','28216':'Oakdale',
  '27601':'Greater Raleigh','27603':'Greater Raleigh','27604':'Greater Raleigh',
  '27605':'Greater Raleigh','27606':'Greater Raleigh','27607':'Greater Raleigh',
  '27608':'Greater Raleigh','27609':'Greater Raleigh','27610':'Greater Raleigh',
  '27612':'Greater Raleigh','27613':'Greater Raleigh','27614':'Greater Raleigh',
  '27615':'Greater Raleigh','27616':'Greater Raleigh','27617':'Greater Raleigh',
  '27540':'Greater Raleigh','27539':'Greater Raleigh',
  '29745':'York / Lake Wylie / Clover','29710':'York / Lake Wylie / Clover',
  '29707':'Indianland','29708':'Fort Mill','29715':'Fort Mill','29716':'Fort Mill',
  '29730':'Rock Hill','29731':'Rock Hill','29734':'Rock Hill',
  '29601':'Greenville','29602':'Greenville','29603':'Greenville','29604':'Greenville',
  '29605':'Greenville','29606':'Greenville','29607':'Greenville','29608':'Greenville',
  '29609':'Greenville','29610':'Greenville','29611':'Greenville','29612':'Greenville',
  '29613':'Greenville','29614':'Greenville','29615':'Greenville','29616':'Greenville',
  '29617':'Greenville',
  '29650':'Greer','29651':'Greer','29652':'Greer',
  '20175':'Leesburg area','20176':'Leesburg area','20158':'Leesburg area',
  '20132':'Leesburg area','20141':'Leesburg area','20197':'Leesburg area','20129':'Leesburg area',
  '22066':'Great Falls','20190':'Reston','20191':'Reston','20194':'Reston',
  '20155':'Gainesville','20147':'Ashburn / Sterling','20148':'Ashburn / Sterling',
  '20164':'Ashburn / Sterling','20165':'Ashburn / Sterling','20166':'Ashburn / Sterling',
  '20105':'Chantilly / Centreville','20151':'Chantilly / Centreville',
  '20152':'Chantilly / Centreville','20171':'Chantilly / Centreville','20120':'Chantilly / Centreville',
}

export const WAITLIST_ZONES = ['Denver']

export const VISIT_TYPE_INFO = {
  'In-home sick visit': {
    color: '#7F77DD', bg: '#EEEDFE', icon: '🏠',
    duration: '60 min',
    note: 'Your provider will arrive within 15 minutes of your scheduled time. Please be available at the visit address with your child ready.',
  },
  'Video telemedicine': {
    color: '#1D9E75', bg: '#E1F5EE', icon: '📹',
    duration: '15 min',
    note: "You'll receive a secure video link by text and email 10 minutes before your appointment.",
  },
  'Sports physical': {
    color: '#EF9F27', bg: '#FAEEDA', icon: '📋',
    duration: '60 min',
    note: "Please have your school's sports clearance form ready if required.",
  },
  'CMA + telemedicine': {
    color: '#378ADD', bg: '#E6F1FB', icon: '🩺',
    duration: '~35 min',
    note: 'Step 1: Your CMA will arrive for diagnostics (~20 min). Step 2: A provider video call follows.',
  },
  'Text visit': {
    color: '#D4537E', bg: '#FBEAF0', icon: '💬',
    duration: 'Response within 2 hrs',
    note: 'A provider will reply within 2 hours during operating hours.',
  },
  'In-home IV fluids': {
    color: '#0F6E56', bg: '#E1F5EE', icon: '💉',
    duration: '60–90 min',
    note: 'Requires provider screening call first. Minimum weight 55 lbs.',
  },
  'In-home CPR class (Heartsaver)': {
    color: '#C0392B', bg: '#FDEDEC', icon: '❤️',
    duration: '3 hours · up to 6 people · $80/person',
    note: `Melissa Jesse will arrive 30 minutes early to set up. After booking, you will receive a Heartsaver e-learning link to complete before class. Payment via Venmo @${VENMO_HANDLE} at $80 per person.`,
  },
  'In-home CPR class (BLS)': {
    color: '#C0392B', bg: '#FDEDEC', icon: '🫀',
    duration: '3 hours · up to 6 people · $80/person',
    note: `Melissa Jesse will arrive 30 minutes early to set up. After booking, you will receive a BLS e-learning link to complete before class. Payment via Venmo @${VENMO_HANDLE} at $80 per person.`,
  },
}

export const COMPLAINT_OPTIONS = [
  'Fever','Ear pain','Sore throat','Rash / skin concern',
  'Vomiting / diarrhea','Cough / congestion','Eye discharge / pink eye',
  'Wound / cut / injury','Urinary symptoms','Allergic reaction','Other',
]

export const TIME_SLOTS = [
  // Morning block: 8:00 AM – 12:30 PM (15-min increments, skip 12:45 for lunch)
  '8:00 AM','8:15 AM','8:30 AM','8:45 AM',
  '9:00 AM','9:15 AM','9:30 AM','9:45 AM',
  '10:00 AM','10:15 AM','10:30 AM','10:45 AM',
  '11:00 AM','11:15 AM','11:30 AM','11:45 AM',
  '12:00 PM','12:15 PM','12:30 PM',
  // Afternoon block: 1:00 PM – 4:30 PM
  '1:00 PM','1:15 PM','1:30 PM','1:45 PM',
  '2:00 PM','2:15 PM','2:30 PM','2:45 PM',
  '3:00 PM','3:15 PM','3:30 PM','3:45 PM',
  '4:00 PM','4:15 PM','4:30 PM',
]
