# Trip Planner

Mobile-first trip planner for multi-stop travel itineraries with shared trip workspaces.

## Stack

- React + Vite
- Tailwind CSS
- Lucide React
- Google Maps + Google Places
- Open-Meteo weather
- AeroDataBox via RapidAPI (server-side)
- Firebase Auth + Firestore

## Local Run

1. Install dependencies:
   `npm install`
2. Copy `.env.example` to `.env.local`.
3. Fill in the Firebase, Google Maps, and AeroDataBox values.
4. Start the app:
   `npm run dev`

## Required Environment Variables

```bash
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
VITE_TRIP_DOC_ID=default-trip
AERODATABOX_RAPIDAPI_KEY=your_aerodatabox_rapidapi_key
AERODATABOX_RAPIDAPI_HOST=aerodatabox.p.rapidapi.com
```

## Firebase Setup

Use this Firebase shape:

- Authentication:
  Enable `Google` sign-in in Firebase Authentication.
- Firestore:
  Create a Firestore database in production mode.
- Rules:
  Deploy [firestore.rules](./firestore.rules).
- Project alias:
  Copy `.firebaserc.example` to `.firebaserc` and replace the project id.

## Firestore Model

- User profile:
  `users/{uid}`
- User trip directory:
  `users/{uid}/tripMemberships/{tripId}`
- Trip meta:
  `trips/{tripId}`
- Trip members:
  `trips/{tripId}/members/{uid}`
- Trip overrides:
  `trips/{tripId}/overrides/shared`

## Permissions

- `owner`: read, edit, manage collaborators
- `editor`: read, edit itinerary
- `viewer`: read only

Firestore rules are expected to enforce the same model as the UI.

## Deployment Checklist

1. Confirm all required Vercel env vars are present.
2. Deploy Firestore rules:
   `firebase deploy --only firestore:rules`
3. Verify Google sign-in works in the deployed domain.
4. Verify Google Maps and Places load with the deployed API key restrictions.

## Notes

- Weather uses Open-Meteo, so there is no weather API key to manage.
- AeroDataBox is wired through `api/aerodatabox.js`, so the RapidAPI key stays off the client.
- Flight items are time-only itinerary events. Add separate airport or transport items if you want route continuity around flights.
- Item detail editing is draft-based with explicit Save / Cancel.
