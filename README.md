# Trip Planner

Mobile-first trip planner for the May 9-13, 2026 Tokyo / Chiba family wedding trip.

## Stack

- React + Vite
- Tailwind CSS
- Lucide React
- Leaflet + OpenStreetMap tiles
- Open-Meteo weather
- Frankfurter exchange rates
- AeroDataBox via RapidAPI (server-side)
- Firebase Auth + Firestore overrides
- OSRM road routing

## Local Run

1. Install dependencies:
   `npm install`
2. Copy `.env.example` to `.env.local`.
3. Fill in the Firebase values.
4. Add the AeroDataBox RapidAPI key if you want flight status lookups.
5. Start the app:
   `npm run dev`

## Firebase Setup

Use this exact Firebase shape:

- Authentication:
  Enable `Anonymous` sign-in in Firebase Authentication.
- Firestore:
  Create a Firestore database in production mode.
- Rules:
  Use [firestore.rules](./firestore.rules).
- Project alias:
  Copy `.firebaserc.example` to `.firebaserc` and replace the project id.

### Environment Variables

Create `.env.local` with:

```bash
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
VITE_TRIP_DOC_ID=tokyo-chiba-wedding-2026
AERODATABOX_RAPIDAPI_KEY=your_aerodatabox_rapidapi_key
AERODATABOX_RAPIDAPI_HOST=aerodatabox.p.rapidapi.com
```

### Firestore Data Model

The app uses a hybrid model:

- Static itinerary seed lives in `src/data/seedItinerary.js`
- Cloud edits are written to:
  `trips/{tripId}/overrides/shared`

Document shape:

```json
{
  "items": {
    "narita-rental-pickup": {
      "title": "Narita Toyota Rent-a-car pickup",
      "startISO": "2026-05-09T16:15:00+09:00",
      "endISO": "2026-05-09T17:00:00+09:00",
      "description": "Edited note",
      "bookingRef": "99945994100"
    }
  },
  "updatedAt": "server timestamp"
}
```

### Recommended Console Steps

1. Create a Firebase project.
2. Add a web app to that project.
3. Enable Anonymous Auth.
4. Enable Firestore.
5. Paste your web app config into `.env.local`.
6. Publish the rules:
   `firebase deploy --only firestore:rules`

## Notes

- Weather uses Open-Meteo, so there is no weather API key to manage.
- AeroDataBox is wired server-side through `api/aerodatabox.js`, so the RapidAPI key stays off the client.
- Frontend helpers for future flight UI live in `src/services/aerodatabox.js`.
- Autosave is debounced to 1000ms before writing to Firestore.
- Long press is 600ms and cancels when touch movement suggests scrolling.
