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

Guest editing works with Vite alone. Signed-in creation, itinerary writes, and trip renames/restores also need the `/api/trip-state` server function and Firebase Admin credentials; use a Vercel development/preview environment for those flows. The Firestore emulator tests require Java 21 or newer.

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
- Removed-member blocks:
  `trips/{tripId}/removedMembers/{uid}`
- Server-only write receipts:
  `trips/{tripId}/writeReceipts/{uid}-{operationId}`

## Permissions

- `owner`: read, edit, manage collaborators
- `admin`: read, edit, manage collaborators
- `editor`: read, edit itinerary
- `viewer`: read only

Firestore rules are expected to enforce the same model as the UI.

Invitation links expire after 1, 7, or 30 days, allow a configured number of joins, and can be revoked from the Share panel. Acceptance consumes one use and creates the member and membership index in one transaction. A link stops working if its creator is no longer an owner or admin.

Removing a member also blocks that account from rejoining through invitation links. An owner or admin can explicitly add the person again by email. Membership identity must match the joining account's token or the invited person's verified profile.

Removal blocks apply to removals made with this version. Earlier removals have no saved block record; revoke outstanding old links if previously removed people must remain excluded.

Signed-in trips read through Firestore's persistent browser cache. Every itinerary edit is first stored in a per-account browser outbox, including edits made while an earlier request is waiting. `/api/trip-state` checks actual membership, validates nested records, compares the edited records with their original versions, and commits edits and date metadata together. Receipts prevent duplicate commits after a lost response. A queued edit is retired only when the corresponding server revision is observed. Conflicts remain on the device with a visible warning; users can review their local version and explicitly discard the rejected changes. Use account-backed editing only on a trusted device because cached trips and queued edits remain in browser storage between sessions.

Malformed legacy records are hidden with a warning and editing is paused. They are not automatically deleted or rewritten. An administrator must repair those records before editing resumes.

## Deployment Checklist

1. Confirm all required Vercel env vars are present.
2. Deploy the frontend and `/api/trip-state` together. Verify authenticated creation and saving in preview with the intended Firebase Admin configuration.
3. Before tightening the rules, have existing clients finish synchronization. Deploy Firestore rules:
   `firebase deploy --only firestore:rules`
   The rules deny direct browser writes to shared itinerary maps. Old open tabs must refresh to use the new API. Do not deploy these rules alone or roll back only the frontend.
4. Verify Google sign-in, invitation acceptance, offline edit/reload/reconnect, and collaborator removal/re-add in the deployed domain.
5. Verify Google Maps and Places load with the deployed API key restrictions.
6. Verify the GitHub feedback token can create issues and labels.

Write receipts and removed-member blocks persist under each trip. Firestore does not cascade-delete subcollections when a trip is deleted; include them in administrative data-retention cleanup. Do not expire receipts while matching browser outbox operations may still be retried.

Security dependency overrides pin patched gRPC, OpenTelemetry, and FTP implementations where upstream constraints retain vulnerable versions. Recheck these overrides when updating Firebase packages. `npm audit` is expected to report zero findings for this lockfile.

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

For human approval and local Codex implementation, see [Feedback to reviewed PR](./docs/feedback-workflow.md). The owner applies `approved-for-build` only after approving a concrete proposal. When the PC is online, Codex claims one approved issue with a unique GitHub branch, implements it locally, runs checks, and opens a PR for human review. The existing Scheduled task was updated to this format on 2026-09-24; future prompt edits must also be copied into that task.

The in-function submission throttle is best-effort because Vercel Functions can run on multiple instances. Firebase sign-in remains the primary inbox protection.

## Notes

- Weather uses Open-Meteo, so there is no weather API key to manage.
- AeroDataBox is wired through `api/aerodatabox.js`, so the RapidAPI key stays off the client.
- Flight items are time-only itinerary events. Add separate airport or transport items if you want route continuity around flights.
- Item detail editing is draft-based with explicit Save / Cancel.
