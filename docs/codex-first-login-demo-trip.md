# Codex Prompt — First-login Demo Trip Generation

Use this file as the implementation brief for adding a safe first-login demo trip workflow.

---

## Goal

Implement a safe first-login demo trip generation workflow.

When a new Google user logs in for the first time and has zero trips, automatically create one minimal editable demo trip.

The demo trip must be generated from code, not copied from a shared Firestore demo document.

Do not rewrite the app.
Do not introduce unrelated redesign.
Do not weaken Firestore rules.
Run `npm run build` and fix all errors.

---

## Core behavior

On Google login:

1. Ensure user profile exists.
2. Load/subscribe to `users/{uid}/tripMemberships`.
3. Load `users/{uid}.onboardingDemoCreated`.
4. Only after trip directory loading is complete:
   - If `trips.length === 0`
   - AND `users/{uid}.onboardingDemoCreated !== true`
   - THEN create demo trip.
5. If user already has trips, do nothing.
6. If user deletes all trips later, do not recreate demo.
7. If `trips/demo-{uid}` already exists, do not create duplicate.
8. After successful demo creation, set `users/{uid}.onboardingDemoCreated = true`.
9. Set the newly created demo trip as the active trip.

---

## Important safety requirements

Prevent all duplicate/partial creation issues:

- Do not create demo based only on the initial empty trips array.
- Use a directory loading flag, not just `trips.length`.
- Use deterministic trip ID: `demo-{uid}`.
- Use an in-memory guard/ref to prevent React StrictMode double creation.
- Before creating, check whether `trips/demo-{uid}` already exists.
- Use one Firestore `writeBatch` to write all demo-related documents together.
- If batch fails, do not set active trip.
- If batch succeeds, set active trip to demo trip.
- Do not recreate demo on refresh/login if `onboardingDemoCreated` is true.
- Do not recreate demo if user later deletes all trips.
- If `trips/demo-{uid}` exists but user trip index is missing, repair the user trip index/membership carefully instead of creating a second demo.

---

## Firestore documents to create

Use trip ID:

```txt
demo-{uid}
```

Create/update these documents in one batch:

### 1. `users/{uid}`

Set/merge:

```txt
uid
displayName
email
photoURL
onboardingDemoCreated: true
updatedAt
```

Do not overwrite unrelated existing profile fields.

### 2. `trips/{demoTripId}`

Fields:

```txt
title: "Demo: 3-Day Tokyo Starter Trip"
startDate: generated Day 1 date
endDate: generated Day 3 date
ownerId: uid
createdBy: uid
isDemo: true
createdAt
updatedAt
```

### 3. `trips/{demoTripId}/members/{uid}`

Fields:

```txt
uid
email
displayName
photoURL
role: "owner"
invitedBy: uid
joinedAt
updatedAt
```

### 4. `users/{uid}/tripMemberships/{demoTripId}`

Fields:

```txt
tripId: demoTripId
role: "owner"
title: "Demo: 3-Day Tokyo Starter Trip"
startDate: generated Day 1 date
endDate: generated Day 3 date
isDemo: true
updatedAt
```

### 5. `trips/{demoTripId}/overrides/shared`

Fields:

```txt
days
items
bookingOptions
updatedAt
```

---

## Firestore rules

Ensure rules allow a signed-in user to create their own demo trip safely.

Rules must not allow all signed-in users to read/write all demo trips.

Required permission shape:

- User can create `trips/{tripId}` only if `request.auth.uid == request.resource.data.ownerId` and `request.auth.uid == request.resource.data.createdBy`.
- User can create `trips/{tripId}/members/{uid}` for themselves as owner only during valid trip creation.
- User can create/update their own `users/{uid}` profile.
- User can create/update their own `users/{uid}/tripMemberships/{tripId}`.
- Only trip members can read trip data.
- Owner/editor permissions should remain intact.
- Viewer must remain read-only.
- Existing `bookingOptions` support must remain intact.

Do not weaken collaboration/security rules.

---

## Demo data location

Do not hard-code all demo data inline inside `App.jsx`.

Preferred implementation:

Create a focused file:

```txt
src/data/demoTrip.js
```

Export something like:

```js
buildDemoTripForUser(user, createdAt = new Date())
```

This function should return:

```txt
tripId
tripMeta
member
userTripMembership
overrides
```

Keep demo generation testable and isolated.

Firebase service can expose a helper such as:

```js
ensureDemoTripForNewUser(user)
```

or:

```js
createDemoTripForUser(user)
```

The logic must remain idempotent.

---

## Dynamic date rule

Demo trip dates must be dynamic.

Do not use fixed dates like `2026-05-09`.

When creating the demo:

- Day 1 = creation local date + 5 days
- Day 2 = Day 1 + 1 day
- Day 3 = Day 1 + 2 days
- Trip `startDate` = Day 1
- Trip `endDate` = Day 3

Use local-date helpers.

Do NOT use `new Date().toISOString().slice(0, 10)` because it may shift dates due to UTC.

Add helpers similar to:

```js
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
```

---

## Demo itinerary strict minimal structure

The visible demo timeline must be extremely minimal.

Each day must have exactly 2 visible itinerary cards.

No extra visible cards.

Do NOT add:

- airport arrival card
- airport departure card
- airport transfer card
- hotel check-in card
- hotel check-out card
- backup visible restaurant card
- backup visible hotel card
- optional suggestions
- extra evening activity
- Tokyo Skytree
- Narita/Haneda logistics cards

---

## Visible timeline

### Day 1

#### Card 1

```txt
Title: Flight HKG to HND (CX548)
Category: Flight
Flight code: CX548
Start time: 08:55
End time: 13:45
Time-only flight item
No locationName
No address
lat: null
lng: null
placeId: ""
Description: Sample demo flight data for illustration. Use flight lookup for live details.
```

#### Card 2

```txt
Title: Dinner near Tokyo Tower
Category: Restaurant
Start time: 19:00
End time: 20:30
Description: Simple arrival-night dinner example.
```

### Day 2

#### Card 1

```txt
Title: teamLab Planets TOKYO
Category: Activity
Start time: 10:00
End time: 12:00
Location/address may be included:
teamLab Planets TOKYO
6-1-16 Toyosu, Koto City, Tokyo 135-0061, Japan
```

If lat/lng are available in existing style, include them. If not, address is enough.

#### Card 2

```txt
Title: Lunch: Tsujihan Nihonbashi
Category: Restaurant
Start time: 12:45
End time: 14:00
```

### Day 3

#### Card 1

```txt
Title: Ueno Park morning walk
Category: Activity
Start time: 09:30
End time: 11:00
```

#### Card 2

```txt
Title: Flight NRT to HKG (CX505)
Category: Flight
Flight code: CX505
Start time: 18:30
End time: 22:20
Time-only flight item
No locationName
No address
lat: null
lng: null
placeId: ""
Description: Sample demo flight data for illustration. Use flight lookup for live details.
```

---

## Expected visible timeline

```txt
Day 1: exactly 2 cards
- Flight HKG to HND (CX548)
- Dinner near Tokyo Tower

Day 2: exactly 2 cards
- teamLab Planets TOKYO
- Lunch: Tsujihan Nihonbashi

Day 3: exactly 2 cards
- Ueno Park morning walk
- Flight NRT to HKG (CX505)
```

---

## Booking options

Booking options can exist in the background, but they must not create extra visible timeline cards.

Add only one booking option group.

Meal booking options linked to the Day 2 lunch item.

### Booking option 1

```txt
title: Tsujihan Nihonbashi
type: meal
status: active
bookingRef: DEMO-MEAL-001
linkedItemId: Day 2 lunch item id
dayId: Day 2 id
reservationTime: Day 2 at 12:45 local time
partySize: 2
cancellationDeadline: Day 1 at 18:00 local time
cancellationPolicy: Demo active lunch booking.
```

### Booking option 2

```txt
title: Tokyo Station backup lunch
type: meal
status: tentative
bookingRef: DEMO-MEAL-002
linkedItemId: Day 2 lunch item id
dayId: Day 2 id
reservationTime: Day 2 at 13:00 local time
partySize: 2
cancellationDeadline: Day 1 at 20:00 local time
cancellationPolicy: Demo backup lunch booking to cancel if not needed.
```

This should demonstrate:

- booking options
- one meal overbooking
- cancellation deadline dashboard
- Day 2 badge count of 1
- overbooking remark on Day 2 lunch card

Do NOT add hotel booking options in this minimal demo unless the app already supports trip-level/unlinked hotel bookings without adding visible cards.

If uncertain, skip hotel booking options.

---

## Flight data warning

Flight numbers and times are demo/sample values.

Do not call AeroDataBox during demo generation.
Do not fetch live flight data.
Do not block demo creation on external APIs.
Do not claim the flight schedule is guaranteed live/current.

Use description text:

```txt
Sample demo flight data for illustration. Use flight lookup for live details.
```

---

## Active trip behavior

After successful demo creation:

- Set `activeTripId` to `demoTripId`.
- Persist active trip in the existing active trip storage mechanism if the app uses one.
- The demo should open automatically or be selected automatically.

If demo creation fails:

- Show a non-blocking error message if current app has an error display pattern.
- Do not loop/retry endlessly.
- Do not create partial duplicate trips.

---

## UI treatment

- Trip title: `Demo: 3-Day Tokyo Starter Trip`.
- If trip directory/header supports it, show a small `Demo` chip when `isDemo` is true.
- Demo trip must be editable/deletable like a normal owned trip.
- Do not make the demo read-only.
- Do not add a tutorial overlay unless already available.

---

## Idempotency details

Use both Firestore and local in-memory safeguards:

- `hasCreatedDemoTripRef` or equivalent in React to prevent duplicate effect execution.
- `onboardingDemoCreated` flag in `users/{uid}`.
- deterministic trip id `demo-{uid}`.
- check existing demo trip document before writing.
- `writeBatch` for all documents.

Pseudo-flow:

```txt
on auth user ready:
  ensure user profile exists
  wait for trip directory loaded
  load user profile/demo flag

if user exists
  and tripDirectoryLoaded
  and trips.length === 0
  and onboardingDemoCreated !== true
  and hasCreatedDemoTripRef.current !== true:
    hasCreatedDemoTripRef.current = true
    call ensureDemoTripForNewUser(user)
    if success:
      set active trip
    if failure:
      hasCreatedDemoTripRef.current = false only if safe to retry manually
```

Important:

Do not mark `onboardingDemoCreated` true before all demo docs are successfully written.

---

## Partial state repair

If `onboardingDemoCreated` is true but no trips are shown:

- Do not automatically create another demo.
- Prefer showing empty state with `Create trip` action.

If `trips/demo-{uid}` exists but user trip index is missing:

Safe repair is acceptable:

- create/repair `users/{uid}/tripMemberships/demo-{uid}`
- ensure `trips/demo-{uid}/members/{uid}` exists as owner

Do not create a second demo.

---

## Acceptance tests

1. New Google user with no trips logs in.
2. App waits until trip directory loading is complete before deciding to create demo.
3. Demo trip is created automatically.
4. Demo trip appears in trip directory.
5. Demo trip is selected/opened automatically.
6. Refresh does not create another demo trip.
7. Logging out and logging back in does not create another demo trip.
8. User who already has any trip does not get a demo trip.
9. User who deletes all trips later does not automatically get another demo because `onboardingDemoCreated` is true.
10. Demo trip ID is `demo-{uid}`.
11. All demo docs are written in one batch.
12. Day 1 equals creation local date + 5 days.
13. Day 2 equals Day 1 + 1 day.
14. Day 3 equals Day 1 + 2 days.
15. Trip startDate equals Day 1.
16. Trip endDate equals Day 3.
17. Day 1 has exactly 2 visible cards.
18. Day 2 has exactly 2 visible cards.
19. Day 3 has exactly 2 visible cards.
20. No visible hotel, transfer, airport, check-in, or check-out cards exist.
21. Both flight items are time-only and have no location fields.
22. Day 2 lunch has two booking options but only one visible lunch card.
23. Cancellation dashboard shows the demo meal deadlines.
24. Day 2 bottom day badge shows excess booking count 1.
25. Overbooking remark appears on the Day 2 lunch card.
26. Viewer/editor/owner permission logic remains intact.
27. Firestore rules still prevent non-members from reading demo trip.
28. `npm run build` passes.

---

## Quality rules

- Keep demo generation isolated and testable.
- Keep demo minimal.
- Do not add extra visible itinerary suggestions.
- Do not fetch live pricing.
- Do not call external APIs.
- Do not add notification/email/calendar integration.
- Do not weaken Firestore rules.
- Do not rewrite unrelated app structure.
- Keep existing visual style.
- Run `npm run build` and fix all errors.

---

## Final output expected from Codex

At the end, summarize:

- Files changed
- Where demo template is defined
- Where demo creation helper lives
- How duplicate creation is prevented
- How partial state is handled
- Firestore rule changes, if any
- Build/test command result
- Any remaining risks

---

## Short prompt to paste into Codex

```txt
Read docs/codex-first-login-demo-trip.md.

Implement the first-login demo trip generation workflow exactly as described.

Do not rewrite the app.
Do not add extra visible itinerary cards.
Do not weaken Firestore rules.
Use dynamic local dates: Day 1 = creation date + 5.
Create a minimal 3-day Tokyo demo trip with exactly 2 visible cards per day.
Use one batch write and deterministic trip id demo-{uid}.
Prevent duplicate demo creation with onboardingDemoCreated, trip directory loaded check, existing demo doc check, and React ref guard.
Run npm run build and fix errors.
At the end, summarize files changed, demo helper location, idempotency protections, Firestore rule changes, and build result.
```
