export const TRIP_ID = import.meta.env.VITE_TRIP_DOC_ID || 'tokyo-chiba-wedding-2026'

export const TRIP_DATES = [
  '2026-05-09',
  '2026-05-10',
  '2026-05-11',
  '2026-05-12',
  '2026-05-13',
]

export const STATIC_ITINERARY = [
  {
    id: 'narita-rental-pickup',
    title: 'Narita Toyota Rent-a-car pickup',
    startISO: '2026-05-09T16:15:00+09:00',
    endISO: '2026-05-09T17:00:00+09:00',
    description:
      'Collect family car after NRT arrival. Confirm child-seat setup, ETC card, and luggage fit before departure.',
    bookingRef: '99945994100',
    category: 'Transit',
    venue: 'Toyota Rent a Car Narita Airport',
    lat: 35.7648,
    lng: 140.3844,
  },
  {
    id: 'hotel-checkin',
    title: 'Ryugujo Spa Hotel Mikazuki Ryugutei check-in',
    startISO: '2026-05-09T18:15:00+09:00',
    endISO: '2026-05-09T19:00:00+09:00',
    description:
      'Unload luggage, settle toddler, and reconfirm breakfast / onsen windows for the next morning.',
    bookingRef: 'BOOKING-CONFIRM-IN-EMAIL',
    category: 'Stay',
    venue: 'Ryugujo Spa Hotel Mikazuki Ryugutei',
    lat: 35.4099,
    lng: 139.9247,
  },
  {
    id: 'resort-morning',
    title: 'Spa resort recovery morning',
    startISO: '2026-05-10T09:30:00+09:00',
    endISO: '2026-05-10T11:30:00+09:00',
    description:
      'Keep the morning flexible for toddler energy, pool time, and early lunch before heading back to Chiba city later.',
    bookingRef: '',
    category: 'Family',
    venue: 'Ryugujo Spa Hotel Mikazuki Ryugutei',
    lat: 35.4099,
    lng: 139.9247,
  },
  {
    id: 'wedding-ceremony',
    title: 'Wedding ceremony',
    startISO: '2026-05-11T12:30:00+09:00',
    endISO: '2026-05-11T15:00:00+09:00',
    description:
      'Arrive changed and photo-ready. Keep rain plan, garment bag, and shugi-fukuro within quick reach.',
    bookingRef: '',
    category: 'Wedding',
    venue: 'Keisei Hotel Miramare, Honchibacho',
    lat: 35.6076,
    lng: 140.1161,
  },
  {
    id: 'wedding-dinner',
    title: 'Wedding dinner',
    startISO: '2026-05-11T18:00:00+09:00',
    endISO: '2026-05-11T20:00:00+09:00',
    description:
      'Dinner at KISAKU in Kaihin Makuhari. Allow time for parking, changing toddler, and evening photos near the bay.',
    bookingRef: '',
    category: 'Dining',
    venue: 'KISAKU, Kaihin Makuhari',
    lat: 35.6482,
    lng: 140.041,
  },
  {
    id: 'outlet-visit',
    title: 'Mitsui Outlet Park sweep',
    startISO: '2026-05-12T10:30:00+09:00',
    endISO: '2026-05-12T14:30:00+09:00',
    description:
      'Prioritize wedding recovery shopping, toddler change station, and food-court break before late-afternoon traffic builds.',
    bookingRef: '',
    category: 'Shopping',
    venue: 'Mitsui Outlet Park Makuhari',
    lat: 35.6488,
    lng: 140.0419,
  },
  {
    id: 'haneda-departure',
    title: 'Haneda departure runway',
    startISO: '2026-05-13T12:00:00+09:00',
    endISO: '2026-05-13T15:30:00+09:00',
    description:
      'Return car buffer, terminal check-in, stroller reset, and final snack stop before HND departure.',
    bookingRef: 'HND-OUTBOUND-FLIGHT',
    category: 'Transit',
    venue: 'Haneda Airport Terminal 3',
    lat: 35.5454,
    lng: 139.7686,
  },
]

export const TRIP_EXPENSES = [
  {
    id: 'hotel',
    label: 'Hotel',
    amountJPY: 48600,
    note: 'Ryugutei stay',
  },
  {
    id: 'car',
    label: 'Car',
    amountJPY: 27800,
    note: 'Toyota rental estimate',
  },
  {
    id: 'shugi',
    label: 'Shugi-fukuro',
    amountJPY: 30000,
    note: 'Wedding envelope',
  },
]
