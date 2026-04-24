# Trip Planner Enhancement Implementation Pack for Codex

Use this file as the repo-local source of truth for the next enhancement work. The goal is to reduce Codex planning time and avoid broad, low-quality rewrites.

## Core constraints

- Do not rewrite the app.
- Keep the existing visual style.
- Keep existing Google Maps, weather, Aerodatabox, day management, generated hotel carry-over, route summary, and Firestore sync working.
- Make changes in small, reviewable phases.
- Prefer focused utility functions over scattered inline logic.
- Run `npm run build` after each phase and fix errors.
- Do not introduce unrelated UI redesign.

## Current repo facts

- Main app: `src/App.jsx`.
- Trip utilities: `src/utils/trip.js`.
- Firebase helpers: `src/services/firebase.js`.
- Seed itinerary: `src/data/seedItinerary.js`.
- Firestore rules: `firestore.rules`.
- Current Firebase model:
  - `trips/{tripId}`
  - `trips/{tripId}/overrides/shared`
- Current auth is anonymous-first through `ensureAnonymousAuth()`.
- Current item shape includes: `id`, `dayId`, `order`, `title`, `flightCode`, `locationName`, `address`, `category`, `startTime`, `endTime`, `description`, `bookingRef`, `travelModeToNext`, `flightInfo`, `lat`, `lng`, `placeId`.
- `App.jsx` already defines `LONG_PRESS_MS`, `MOVE_THRESHOLD`, `DROP_DAY_SWITCH_MS`, and `SAVE_DEBOUNCE_MS`.

---

# Phase 1 — Timeline sorting + duration-based end time

## Goal

Improve event time behavior:

1. Auto timeline ordering based on `startTime`.
2. Flexible end-time input where the user can either enter a direct `endTime` or enter `durationMinutes`, with `endTime` derived from `startTime + durationMinutes`.

## Do not change in this phase

- Do not change auth.
- Do not change collaboration.
- Do not change Flight item location behavior.
- Do not change overall UI design.

## Data model additions

Each itinerary item should support:

```js
{
  startTime: '14:30',
  endTime: '16:00',
  endTimeMode: 'time' | 'duration',
  durationMinutes: 90 | null
}
```

Backward compatibility:

```js
endTimeMode: item.endTimeMode || 'time'
durationMinutes: Number.isFinite(item.durationMinutes) ? item.durationMinutes : null
```

`endTime` remains the canonical field for display, conflict detection, route pacing, and Firestore compatibility.

## Utility functions to add to `src/utils/trip.js`

```js
export function timeToMinutes(time = '00:00') {
  const [hours = 0, minutes = 0] = String(time || '00:00').split(':').map(Number)
  return hours * 60 + minutes
}

export function minutesToTime(totalMinutes) {
  const normalized = ((Number(totalMinutes || 0) % 1440) + 1440) % 1440
  const hours = Math.floor(normalized / 60)
  const minutes = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function deriveEndTimeFromDuration(startTime, durationMinutes) {
  const duration = Number(durationMinutes || 0)
  if (!startTime || !duration) return startTime || '00:00'
  return minutesToTime(timeToMinutes(startTime) + duration)
}

export function getDurationMinutes(startTime, endTime) {
  if (!startTime || !endTime) return null
  const diff = timeToMinutes(endTime) - timeToMinutes(startTime)
  return diff >= 0 ? diff : null
}

export function normalizeItemTimeFields(item) {
  const endTimeMode = item.endTimeMode === 'duration' ? 'duration' : 'time'
  const durationMinutes = Number.isFinite(Number(item.durationMinutes))
    ? Number(item.durationMinutes)
    : null

  if (endTimeMode === 'duration' && durationMinutes) {
    return {
      ...item,
      endTimeMode,
      durationMinutes,
      endTime: deriveEndTimeFromDuration(item.startTime, durationMinutes),
    }
  }

  return {
    ...item,
    endTimeMode,
    durationMinutes,
  }
}

export function sortItemsByTimeline(items) {
  return [...items]
    .filter((item) => !item.hidden)
    .sort((a, b) => {
      const timeCompare = compareTime(a.startTime || '23:59', b.startTime || '23:59')
      if (timeCompare !== 0) return timeCompare
      return (a.order ?? 0) - (b.order ?? 0)
    })
}

export function normalizeDayTimelineOrder(items, dayId) {
  return sortItemsByTimeline(items.filter((item) => item.dayId === dayId)).map((item, index) => ({
    ...item,
    order: index,
  }))
}
```

## Required logic changes

- Update `sortItems()` so it prioritizes `startTime` before `order`.
- Update local `assignItemOrder()` in `App.jsx` or replace it with the utility so it also prioritizes `startTime` before `order`.
- After add/edit/move item, normalize the affected day(s) using timeline order.
- If drag/reorder remains, it should only matter as tie-break for same `startTime`.
- Update `serializeTripState()` to include `endTimeMode` and `durationMinutes`.
- Update `buildEmptyDraft()` to initialize:

```js
endTimeMode: 'time',
durationMinutes: null,
```

## UI changes

In the item form, replace simple end-time-only UX with:

- Segmented control: `End time` / `Duration`.
- If `End time`: show normal `endTime` input.
- If `Duration`: show duration input and quick buttons: `30m`, `45m`, `1h`, `1h30`, `2h`, `3h`.
- Show derived end time as read-only when in duration mode.
- Helper copy: `Use duration when you know how long the stop takes. The app will calculate the end time.`
- Timeline helper copy somewhere near the day list: `Timeline auto-sorts by start time. Drag only affects items with the same start time.`

## Validation

If `endTime` is earlier than `startTime`, show warning:

`End time is earlier than start time. For overnight items, split into two items.`

Do not implement overnight item logic.

## Acceptance tests

- Add item at 17:00; confirm it appears after 14:00 item.
- Edit an item from 17:00 to 09:00; confirm it moves earlier.
- Set start `14:30`, duration `90`; confirm end becomes `16:00`.
- Reload and confirm `endTimeMode` and `durationMinutes` persist.
- Existing items without the new fields still load.
- `npm run build` passes.

---

# Phase 2 — Mobile card interaction + long-press quick actions

## Goal

Improve item card interactions:

1. Make the whole visible item card reliably tappable on mobile.
2. Change long press from direct edit to a quick actions menu.

## Do not change in this phase

- Do not change auth.
- Do not change collaboration.
- Do not change Flight item location behavior.
- Do not remove existing route/map/weather functionality.

## Single tap requirements

- Single tap anywhere on the visible card should trigger the normal item action.
- The tappable area must match the full visible card including padding.
- Minimum touch target should feel mobile-native, around 44px high or more.
- Add pressed/active feedback to the whole card.
- Avoid attaching `onClick` only to inner text.

If the card cannot be a `<button>` because it contains nested buttons, use:

```jsx
<div
  role="button"
  tabIndex={0}
  onClick={() => handleItemTap(item)}
  onKeyDown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') handleItemTap(item)
  }}
>
  ...
</div>
```

Nested controls must call `event.stopPropagation()`.

## Long press requirements

- Long press opens quick actions menu.
- Long press no longer opens edit directly.
- Long press must not also trigger normal tap afterward.
- Reuse existing `LONG_PRESS_MS` and `MOVE_THRESHOLD`.
- Cancel long press if pointer moves more than `MOVE_THRESHOLD`.

Use a guard like:

```js
const longPressTriggeredRef = useRef(false)

function handleLongPress(item) {
  longPressTriggeredRef.current = true
  openQuickActions(item)
}

function handleItemTap(item) {
  if (longPressTriggeredRef.current) {
    longPressTriggeredRef.current = false
    return
  }
  openItemDetail(item)
}
```

## Quick actions menu

Actions:

1. Edit details
2. Open in Google Maps
3. Cancel

Prefer a bottom sheet for mobile and desktop initially.

Show:

- Item title.
- Time range.
- Action buttons.

## Google Maps helpers

Add helpers, likely in `App.jsx` or a small utility:

```js
function canOpenInGoogleMaps(item) {
  return Boolean(
    item &&
      item.category !== 'Flight' &&
      (item.placeId ||
        (typeof item.lat === 'number' && typeof item.lng === 'number') ||
        item.address ||
        item.locationName)
  )
}

function buildGoogleMapsUrl(item) {
  if (item.placeId) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      item.locationName || item.address || item.title,
    )}&query_place_id=${encodeURIComponent(item.placeId)}`
  }

  if (typeof item.lat === 'number' && typeof item.lng === 'number') {
    return `https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}`
  }

  const query = item.address || item.locationName || item.title
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
}
```

Note: this already hides Maps for Flight items so Phase 3 is easier.

## Acceptance tests

- Tap anywhere on item card opens expected item action.
- Long press opens quick actions.
- Long press does not also open edit.
- Edit details opens existing modal.
- Open in Google Maps opens correct URL.
- Nested controls do not trigger card tap.
- Drag/reorder still works if retained.
- `npm run build` passes.

---

# Phase 3 — Flight item no longer stores location

## Goal

Make Flight items time-only itinerary events, not physical route/map points.

## New rule

Flight items should not store or rely on:

- `locationName`
- `address`
- `lat`
- `lng`
- `placeId`

Flight API lookup may update:

- `category`
- `flightCode`
- `title`
- `startTime`
- `endTime`
- `description`
- `flightInfo`

## Required code changes

Update `applyFlightRecordToDraft()` so it clears map fields:

```js
return {
  ...item,
  category: 'Flight',
  flightCode,
  title: buildFlightTitle(record, flightCode),
  locationName: '',
  address: '',
  startTime: formatLocalTimeToClock(record.scheduledDeparture) || item.startTime,
  endTime: formatLocalTimeToClock(record.scheduledArrival) || item.endTime,
  lat: null,
  lng: null,
  placeId: '',
  description: mergeFlightInfoIntoDescription(item.description, record),
  flightInfo: { ... }
}
```

Map/routing changes:

- Route/map logic should skip Flight items as physical points.
- Do not use `flightInfo.departureAirportLocation` or `flightInfo.arrivalAirportLocation` as anchors.
- Remove or disable `getFlightAnchor()` and `getResolvedFlightAnchor()` if no longer needed.
- `resolveTravelPoint()` should return `null` for `category === 'Flight'`.
- `buildMapItems()` should not create pins from Flight items.
- `makeMovementPairs()` should connect only real physical items with lat/lng.

UI helper in Flight form:

`Flight items do not create map pins. Add a separate airport or transport item before/after this flight to keep route continuity.`

## Seed data

Update `src/data/seedItinerary.js`:

- Flight items should have empty location fields and null coordinates.
- Add separate physical logistics items where needed:
  - Narita arrival / airport logistics item.
  - Haneda airport check-in / departure logistics item.

## Backward compatibility

Old Firestore Flight items may still have legacy lat/lng. Treat all `category === 'Flight'` as non-location regardless of legacy fields.

## Acceptance tests

- Flight lookup updates flight details but does not add map fields.
- Flight cards still show flight time/details.
- Routes skip Flight items.
- Adding a separate airport item restores route continuity.
- Long press on Flight item shows Edit details but not Open in Google Maps.
- Old Flight items with lat/lng do not break the app.
- `npm run build` passes.

---

# Phase 4 — Google Firebase login + user trip segregation

## Goal

Replace anonymous-first auth with Google login and segregate trips by user.

## Do not implement yet

- Do not build full collaborator management UI in this phase.
- Do not build email invitation flow in this phase.

## Auth requirements

- Use Firebase Auth `GoogleAuthProvider`.
- Add `signInWithGoogle()`.
- Add `signOutUser()`.
- Add auth-state subscription/helper.
- Show sign-in screen when logged out.
- Show signed-in user name/photo/email somewhere in header or trip directory.
- Add sign-out button.

## User profile document

On login, create/update:

```txt
users/{uid}
  uid
  displayName
  email
  photoURL
  createdAt
  updatedAt
```

## Ownership/membership model

Trip document:

```txt
trips/{tripId}
  title
  startDate
  endDate
  ownerId
  createdBy
  createdAt
  updatedAt
  hidden
```

Trip member document:

```txt
trips/{tripId}/members/{uid}
  uid
  email
  displayName
  photoURL
  role: "owner"
  invitedBy
  joinedAt
  updatedAt
```

Recommended user trip index:

```txt
users/{uid}/tripMemberships/{tripId}
  tripId
  role
  title
  startDate
  endDate
  updatedAt
```

Use `users/{uid}/tripMemberships` for trip directory. Use `trips/{tripId}/members/{uid}` for security.

## Firebase service changes

Update `src/services/firebase.js` to export helpers like:

- `subscribeToAuthState`
- `signInWithGoogle`
- `signOutUser`
- `ensureUserProfile`
- `createTripRecordWithOwner`
- `subscribeToUserTripDirectory`
- `subscribeToTripMember`

Keep `mergeTripPatch()` and `subscribeToTripState()` working.

## Migration behavior

Existing `default-trip` may be legacy. If signed-in user opens a legacy trip with no members, allow claiming it by creating:

- `ownerId = current uid`
- `trips/{tripId}/members/{uid}` role owner
- `users/{uid}/tripMemberships/{tripId}`

Be conservative. Do not expose all trips globally after rules are updated.

## Firestore rules direction

Rules should prepare for owner/editor/viewer, even if only owner exists in this phase.

Functions:

```js
function isSignedIn() {
  return request.auth != null;
}

function isTripMember(tripId) {
  return exists(/databases/$(database)/documents/trips/$(tripId)/members/$(request.auth.uid));
}

function memberRole(tripId) {
  return get(/databases/$(database)/documents/trips/$(tripId)/members/$(request.auth.uid)).data.role;
}

function canViewTrip(tripId) {
  return isSignedIn() && isTripMember(tripId);
}

function canEditTrip(tripId) {
  return canViewTrip(tripId) && memberRole(tripId) in ['owner', 'editor'];
}

function isTripOwner(tripId) {
  return canViewTrip(tripId) && memberRole(tripId) == 'owner';
}
```

High-level permissions:

- Trip members can read trip.
- Owner/editor can write overrides.
- Viewers cannot write.
- Owner can manage members.

## Acceptance tests

- Logged-out user sees sign-in screen.
- Google login works.
- User profile doc is created.
- New trip creates owner membership.
- Trip directory only shows current user trips.
- Owner can edit itinerary.
- Another signed-in user cannot read/write trip unless member.
- `npm run build` passes.

---

# Phase 5 — Collaboration roles

## Goal

Add owner/editor/viewer collaboration.

## Role permissions

Owner:

- Read trip.
- Edit itinerary.
- Edit trip meta.
- Manage collaborators.
- Change roles.
- Remove collaborators.

Editor:

- Read trip.
- Edit itinerary items/days.
- Cannot manage collaborators.

Viewer:

- Read trip only.
- Cannot add/edit/delete/reorder items.
- Cannot edit days.
- Cannot edit trip meta.
- Cannot change route modes.
- Cannot run flight lookup changes.

## UI permission helpers

Add helpers:

```js
function canViewTrip(role) {
  return ['owner', 'editor', 'viewer'].includes(role)
}

function canEditTrip(role) {
  return ['owner', 'editor'].includes(role)
}

function canManageMembers(role) {
  return role === 'owner'
}
```

Use these helpers to hide/disable controls.

## Collaborator management UI

Add a simple Share / Collaborators panel.

Owner can:

- Search/add collaborator by email.
- Assign role: editor/viewer.
- Change existing collaborator role.
- Remove collaborator.

Constraints:

- Do not allow removal of the last owner.
- Do not allow demoting self if self is the only owner.
- Invite flow can require the other user to have signed in once.
- If email not found in `users`, show:
  `This person needs to sign in once before they can be added.`
- Do not build email invitation system in this phase.

## Data sync

When adding/updating/removing member, update both:

- `trips/{tripId}/members/{uid}`
- `users/{uid}/tripMemberships/{tripId}`

## Firestore rules

- Only owner can create/update/delete members.
- Owner/editor can write overrides.
- Viewer can read only.
- Non-member cannot read.
- Protect against users assigning themselves owner.

## Acceptance tests

- Owner can add editor/viewer.
- Editor can edit itinerary but cannot manage collaborators.
- Viewer can read but cannot edit.
- Viewer UI does not show misleading edit controls.
- Non-member cannot read trip.
- Owner cannot remove last owner.
- `npm run build` passes.

---

# Phase 6 — Regression and deployment checklist

## Goal

Stabilize all previous phases.

## Regression checklist

- `npm run build` passes.
- No console errors on initial load.
- Logged-out state works.
- Google sign-in works.
- Trip list loads after sign-in.
- Creating a trip works.
- Editing trip title/date works if supported.
- Adding item works.
- Editing item works.
- Deleting item works.
- Timeline sorting works.
- Duration mode persists after reload.
- Long press opens quick actions.
- Single tap works across full item card.
- Google Maps opens for real location items.
- Google Maps hidden for Flight items.
- Flight lookup updates flight details but does not add location.
- Route map skips Flight items.
- Weather still works.
- Generated hotel carry-over still works.
- Firestore rules match actual reads/writes.
- Viewer cannot write.
- Editor can edit itinerary.
- Owner can manage collaborators.

## Deployment reminders

If `firestore.rules` changed, deploy rules:

```bash
firebase deploy --only firestore:rules
```

Verify Vercel env vars:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_GOOGLE_MAPS_API_KEY`
- Aerodatabox env vars currently used by the app

## Final output expected from Codex

- Summarize files changed.
- Summarize tests run.
- Summarize remaining risks.
- Do not introduce unrelated redesign.
