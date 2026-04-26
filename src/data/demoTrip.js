import { SEED_DAYS, SEED_ITEMS } from './seedItinerary'

const DEMO_TITLE = 'Demo: 3-Day Tokyo Starter Trip'

function addDaysToLocalDate(date, days) {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

function toLocalDateString(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toLocalDateTimeString(dateString, time) {
  return `${dateString}T${time}:00`
}

function publicUserFields(user) {
  return {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || '',
    photoURL: user.photoURL || '',
  }
}

function flightItem({ dayId, endTime, flightCode, id, order, startTime, title }) {
  return {
    id,
    dayId,
    order,
    title,
    category: 'Flight',
    startTime,
    endTime,
    endTimeMode: 'time',
    durationMinutes: null,
    description: 'Sample demo flight data for illustration. Use flight lookup for live details.',
    bookingRef: '',
    flightCode,
    locationName: '',
    address: '',
    lat: null,
    lng: null,
    placeId: '',
    travelModeToNext: '',
    flightInfo: null,
  }
}

export function buildDemoTripForUser(user, createdAt = new Date()) {
  const tripId = `demo-${user.uid}`
  const day1Date = toLocalDateString(addDaysToLocalDate(createdAt, 5))
  const day2Date = toLocalDateString(addDaysToLocalDate(createdAt, 6))
  const day3Date = toLocalDateString(addDaysToLocalDate(createdAt, 7))
  const day1Id = `${tripId}-day-1`
  const day2Id = `${tripId}-day-2`
  const day3Id = `${tripId}-day-3`
  const lunchItemId = `${tripId}-lunch-tsujihan`
  const userFields = publicUserFields(user)

  const tripMeta = {
    title: DEMO_TITLE,
    startDate: day1Date,
    endDate: day3Date,
    ownerId: user.uid,
    createdBy: user.uid,
    hidden: false,
    isDemo: true,
  }

  return {
    tripId,
    tripMeta,
    member: {
      ...userFields,
      role: 'owner',
      invitedBy: user.uid,
    },
    userTripMembership: {
      tripId,
      role: 'owner',
      title: DEMO_TITLE,
      startDate: day1Date,
      endDate: day3Date,
      hidden: false,
      isDemo: true,
    },
    overrides: {
      days: {
        ...Object.fromEntries(SEED_DAYS.map((day) => [day.id, { ...day, hidden: true }])),
        [day1Id]: {
          id: day1Id,
          date: day1Date,
          name: 'Arrival',
          order: 0,
        },
        [day2Id]: {
          id: day2Id,
          date: day2Date,
          name: '',
          order: 1,
        },
        [day3Id]: {
          id: day3Id,
          date: day3Date,
          name: 'Departure',
          order: 2,
        },
      },
      items: {
        ...Object.fromEntries(SEED_ITEMS.map((item) => [item.id, { ...item, hidden: true }])),
        [`${tripId}-flight-cx548`]: flightItem({
          id: `${tripId}-flight-cx548`,
          dayId: day1Id,
          order: 0,
          title: 'Flight HKG to HND (CX548)',
          flightCode: 'CX548',
          startTime: '08:55',
          endTime: '13:45',
        }),
        [`${tripId}-dinner-tokyo-tower`]: {
          id: `${tripId}-dinner-tokyo-tower`,
          dayId: day1Id,
          order: 1,
          title: 'Dinner near Tokyo Tower',
          locationName: '',
          address: '',
          category: 'Restaurant',
          startTime: '19:00',
          endTime: '20:30',
          endTimeMode: 'time',
          durationMinutes: null,
          description: 'Simple arrival-night dinner example.',
          bookingRef: '',
          status: 'considering',
          cancellationDeadline: '',
          lat: null,
          lng: null,
          placeId: '',
          travelModeToNext: '',
        },
        [`${tripId}-teamlab-planets`]: {
          id: `${tripId}-teamlab-planets`,
          dayId: day2Id,
          order: 0,
          title: 'teamLab Planets TOKYO',
          locationName: 'teamLab Planets TOKYO',
          address: '6-1-16 Toyosu, Koto City, Tokyo 135-0061, Japan',
          category: 'Activity',
          startTime: '10:00',
          endTime: '12:00',
          endTimeMode: 'time',
          durationMinutes: null,
          description: '',
          bookingRef: '',
          lat: 35.6491,
          lng: 139.7898,
          placeId: '',
          travelModeToNext: '',
        },
        [lunchItemId]: {
          id: lunchItemId,
          dayId: day2Id,
          order: 1,
          title: 'Lunch: Tsujihan Nihonbashi',
          locationName: 'Tsujihan Nihonbashi',
          address: '',
          category: 'Restaurant',
          startTime: '12:45',
          endTime: '14:00',
          endTimeMode: 'time',
          durationMinutes: null,
          description: '',
          bookingRef: '',
          status: '',
          cancellationDeadline: '',
          lat: null,
          lng: null,
          placeId: '',
          travelModeToNext: '',
        },
        [`${tripId}-ueno-park`]: {
          id: `${tripId}-ueno-park`,
          dayId: day3Id,
          order: 0,
          title: 'Ueno Park morning walk',
          locationName: 'Ueno Park',
          address: '',
          category: 'Activity',
          startTime: '09:30',
          endTime: '11:00',
          endTimeMode: 'time',
          durationMinutes: null,
          description: '',
          bookingRef: '',
          lat: 35.7156,
          lng: 139.7745,
          placeId: '',
          travelModeToNext: '',
        },
        [`${tripId}-flight-cx505`]: flightItem({
          id: `${tripId}-flight-cx505`,
          dayId: day3Id,
          order: 1,
          title: 'Flight NRT to HKG (CX505)',
          flightCode: 'CX505',
          startTime: '18:30',
          endTime: '22:20',
        }),
      },
      bookingOptions: {
        [`${tripId}-meal-booking-active`]: {
          id: `${tripId}-meal-booking-active`,
          title: 'Tsujihan Nihonbashi',
          type: 'meal',
          status: 'active',
          bookingRef: 'DEMO-MEAL-001',
          linkedItemId: lunchItemId,
          dayId: day2Id,
          reservationTime: toLocalDateTimeString(day2Date, '12:45'),
          partySize: 2,
          cancellationDeadline: toLocalDateTimeString(day1Date, '18:00'),
          cancellationPolicy: 'Demo active lunch booking.',
          provider: '',
          startDate: '',
          endDate: '',
          price: null,
          currency: 'JPY',
          notes: '',
        },
        [`${tripId}-meal-booking-backup`]: {
          id: `${tripId}-meal-booking-backup`,
          title: 'Tokyo Station backup lunch',
          type: 'meal',
          status: 'tentative',
          bookingRef: 'DEMO-MEAL-002',
          linkedItemId: lunchItemId,
          dayId: day2Id,
          reservationTime: toLocalDateTimeString(day2Date, '13:00'),
          partySize: 2,
          cancellationDeadline: toLocalDateTimeString(day1Date, '20:00'),
          cancellationPolicy: 'Demo backup lunch booking to cancel if not needed.',
          provider: '',
          startDate: '',
          endDate: '',
          price: null,
          currency: 'JPY',
          notes: '',
        },
      },
    },
  }
}
