export const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const DEFAULT_AVAILABILITY = DAYS_OF_WEEK.map((_day, i) => ({
  day_of_week: i,
  is_active: i >= 1 && i <= 5,
  start_time: '08:00',
  end_time: '17:00',
}))

