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
3. Fill in the Firebase, Google Maps, AeroDataBox, and GitHub feedback values.
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
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@example.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GITHUB_FEEDBACK_TOKEN=github_pat_your_fine_grained_token
GITHUB_FEEDBACK_REPOSITORY=bryanwongkc/trip-planner
```

## Firebase Setup

Use this Firebase shape:

- Authentication:
  Enable `Google` sign-in in Firebase Authentication.
- Firestore:
  Create a Firestore database in production mode.
- Admin service account:
  Add the three server-only `FIREBASE_*` values above to the deployment environment. They power authenticated server APIs and must never use a `VITE_` prefix.
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
- Trip invitation links:
  `tripInvites/{inviteId}`
- Trip overrides:
  `trips/{tripId}/overrides/shared`

## Permissions

- `owner`: read, edit, manage collaborators
- `admin`: read, edit, manage collaborators
- `editor`: read, edit itinerary
- `viewer`: read only

Firestore rules are expected to enforce the same model as the UI.

Invitation links expire after 1, 7, or 30 days, allow a configured number of joins, and can be revoked from the Share panel. Acceptance consumes one use and creates the member and membership index in one transaction. A link stops working if its creator is no longer an owner or admin.

Signed-in trips use Firestore's persistent browser cache so pending changes survive reloads and network loss. Use account-backed editing only on a device you trust because the browser retains that cache between sessions.

## Deployment Checklist

1. Confirm all required Vercel env vars are present.
2. Deploy Firestore rules:
   `firebase deploy --only firestore:rules`
3. Verify Google sign-in works in the deployed domain.
4. Verify Google Maps and Places load with the deployed API key restrictions.
5. Verify the GitHub feedback token can create issues and labels.

## Daily Feedback Review

Signed-in users can send product feedback from **Trip menu -> Give feedback**. The Vercel API verifies the Firebase identity and creates an issue in the public `bryanwongkc/trip-planner` repository. Feedback issues contain only the note, category, optional rating, and current screen. They do not contain the user's name, email, Firebase UID, trip name, trip ID, day ID, itinerary stops, or booking details.

Add this server-only variable to Vercel:

- `GITHUB_FEEDBACK_TOKEN`: a fine-grained GitHub personal access token scoped to `bryanwongkc/trip-planner`, with **Metadata: read** and **Issues: read and write** permissions.

`GITHUB_FEEDBACK_REPOSITORY` is optional and defaults to `bryanwongkc/trip-planner`. Neither variable may use a `VITE_` prefix. No OpenAI API key, GitHub Actions secret, or Firestore rule change is needed.

To review feedback daily in ChatGPT:

1. Connect the GitHub plugin to `bryanwongkc/trip-planner`.
2. Create a ChatGPT Scheduled task for 09:00 Asia/Hong_Kong.
3. Paste the contents of [the daily review prompt](./.github/chatgpt/daily-feedback-review.md).
4. Run the prompt once manually before enabling the daily schedule. It creates a consolidated proposal issue, then labels the source issues `feedback-reviewed`; it never modifies product code.

The in-function submission throttle is best-effort because Vercel Functions can run on multiple instances. Firebase sign-in remains the primary inbox protection.

## Notes

- Weather uses Open-Meteo, so there is no weather API key to manage.
- AeroDataBox is wired through `api/aerodatabox.js`, so the RapidAPI key stays off the client.
- Flight items are time-only itinerary events. Add separate airport or transport items if you want route continuity around flights.
- Item detail editing is draft-based with explicit Save / Cancel.
