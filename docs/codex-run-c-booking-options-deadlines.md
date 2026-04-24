# Codex Run C — Booking Options Stack + Cancellation Deadline Dashboard

Use this prompt after Run A and Run B are completed and merged.

Run A should already have implemented:

- Timeline sorting by start time.
- Duration-based end time.
- Save / Cancel draft-based item editing.
- Mobile card tap sensitivity fix.
- Long-press quick actions.
- Flight items as time-only events.

Run B should already have implemented:

- Google login.
- User trip segregation.
- Owner/editor/viewer collaboration roles.
- Firestore rules enforcing member access.

This Run C adds a new product module: hotel/meal booking options and cancellation deadline tracking.

---

# Product concept

Real trip planning often includes multiple tentative hotel or restaurant bookings. Users may hold several options and cancel the weaker ones later.

The app should help users answer:

```txt
What bookings am I holding, which one is active, and what do I need to cancel before I get charged?
```

This is not just another itinerary item type. It is a booking-option management layer linked to itinerary items.

---

# Run C goal

Implement:

1. Booking options for hotels and meal reservations.
2. Clean stack view on linked itinerary cards.
3. Free-cancellation deadline tracking.
4. A dedicated Cancellation Deadlines screen.
5. Role-aware editing using existing owner/editor/viewer permissions.

Do not implement push notifications, email reminders, OCR, booking email import, or Google Calendar sync in this run.

---

# Core UX model

## Itinerary card stack summary

For Hotel and Meal-related itinerary items, show a compact booking-options summary when linked booking options exist.

Example card summary:

```txt
3 booking options
Next free-cancel deadline: 6 May, 18:00
```

The itinerary card should remain clean. Do not show all booking details inline on the main timeline.

Tapping/opening the booking stack should show all options linked to that itinerary item.

## Booking options stack view

The stack view should show booking options linked to one itinerary item.

Each booking option should show:

- Booking title / hotel or restaurant name.
- Status: Active, Considering, Cancelled, Deadline passed.
- Cancellation deadline if present.
- Booking reference if present.
- Provider if present.
- Price/currency if present.
- Notes if present.
- Actions depending on role and status:
  - Mark active.
  - Mark cancelled.
  - Edit.
  - Delete/remove if appropriate.

Only one option linked to the same itinerary item should normally be `active` at a time. If the user marks one option active, other non-cancelled options for the same item should become `tentative`.

## Cancellation Deadlines screen

Add a dedicated screen/tab/panel called:

```txt
Cancellation Deadlines
```

This screen shows all non-cancelled booking options with a cancellation deadline, sorted by urgency.

Group or visually separate:

- Overdue / deadline passed.
- Today.
- Tomorrow.
- This week.
- Later.

Each row should show:

- Booking title.
- Booking type: Hotel or Meal.
- Linked day/date if available.
- Cancellation deadline.
- Status.
- Booking reference if available.
- Linked itinerary item title if available.
- Action: Mark cancelled.
- Action: Open details.

This screen is a tracking dashboard, not a notification system.

---

# Data model

Add booking options to the existing trip state. Choose a structure that fits the current Firestore override pattern and collaboration rules.

Preferred option: include bookingOptions in the shared override document alongside days and items.

```txt
trips/{tripId}/overrides/shared
  days
  items
  bookingOptions
  updatedAt
```

Booking option shape:

```js
{
  id: 'booking-...',
  linkedItemId: 'item-...',
  dayId: 'day-...',

  type: 'hotel' | 'meal',
  title: 'The Prince Park Tower Tokyo',
  provider: 'Booking.com',
  bookingRef: 'ABC123',

  status: 'active' | 'tentative' | 'cancelled',

  startDate: '2026-05-10',
  endDate: '2026-05-13',
  reservationTime: '2026-05-12T17:00:00+09:00',
  partySize: 3,

  cancellationDeadline: '2026-05-07T23:59:00+09:00',
  cancellationPolicy: 'Free cancellation until 7 May 23:59',

  price: 120000,
  currency: 'JPY',

  notes: '',
  createdAt: client timestamp or server timestamp where available,
  updatedAt: client timestamp or server timestamp where available
}
```

Notes:

- `expired` / `deadline passed` should usually be derived, not manually stored.
- Keep `status` simple: active / tentative / cancelled.
- If `cancellationDeadline` is in the past and status is not cancelled, display as Deadline passed.
- Do not create a separate top-level collection unless necessary.

---

# Utility functions

Add utilities in a suitable file, likely `src/utils/trip.js` or a new focused utility file if cleaner.

Suggested helpers:

```js
export function deriveBookingDeadlineState(booking, now = new Date()) {
  if (booking.status === 'cancelled') return 'cancelled'
  if (!booking.cancellationDeadline) return 'no_deadline'

  const deadline = new Date(booking.cancellationDeadline)
  if (Number.isNaN(deadline.getTime())) return 'invalid_deadline'

  const diffMs = deadline.getTime() - now.getTime()
  if (diffMs < 0) return 'overdue'
  if (diffMs <= 24 * 60 * 60 * 1000) return 'due_soon'
  if (diffMs <= 7 * 24 * 60 * 60 * 1000) return 'upcoming'
  return 'later'
}

export function sortBookingOptionsByDeadline(bookings, now = new Date()) {
  return [...bookings].sort((a, b) => {
    const aTime = a.cancellationDeadline ? new Date(a.cancellationDeadline).getTime() : Infinity
    const bTime = b.cancellationDeadline ? new Date(b.cancellationDeadline).getTime() : Infinity
    return aTime - bTime
  })
}

export function bookingsForItem(bookings, itemId) {
  return bookings.filter((booking) => booking.linkedItemId === itemId && booking.status !== 'cancelled')
}

export function nextCancellationDeadline(bookings, now = new Date()) {
  return sortBookingOptionsByDeadline(
    bookings.filter((booking) => booking.status !== 'cancelled' && booking.cancellationDeadline),
    now,
  )[0] || null
}
```

---

# Firestore serialization / sync

Update serialization and merging so `bookingOptions` persist with the trip.

Current shared override document includes days/items. Extend it to include bookingOptions.

Required changes:

- `serializeTripState()` should include `bookingOptions`.
- `deriveTripState()` should merge seed/default booking options if any exist later, but this run can start with empty bookings.
- `mergeTripPatch()` in `src/services/firebase.js` should accept and stamp `bookingOptions` similarly to items/days.
- Firestore rules must allow `bookingOptions` in the shared override doc shape.

Update rules validation from only days/items/updatedAt to also allow bookingOptions.

Example rule shape direction:

```js
function isSharedOverrideDoc() {
  return request.resource.data.keys().hasOnly(['days', 'items', 'bookingOptions', 'updatedAt']) &&
    (!('days' in request.resource.data) || request.resource.data.days is map) &&
    (!('items' in request.resource.data) || request.resource.data.items is map) &&
    (!('bookingOptions' in request.resource.data) || request.resource.data.bookingOptions is map);
}
```

Keep owner/editor/viewer permissions from Run B intact:

- owner/editor can write booking options.
- viewer can read only.
- non-member cannot read.

---

# UI permissions

Use existing role helpers from Run B.

Owner/editor:

- Can add booking option.
- Can edit booking option.
- Can mark active.
- Can mark cancelled.
- Can delete/remove booking option if implemented.

Viewer:

- Can view booking stack.
- Can view cancellation dashboard.
- Cannot add/edit/mark/delete booking options.

---

# Form behavior

Booking option forms must follow the same Save / Cancel pattern from item detail editing.

Required behavior:

```txt
Open booking option form
→ copy booking into local draft
→ edit fields locally
→ Save persists
→ Cancel discards
```

Do not auto-save booking option field edits to Firestore.

Suggested fields:

- Type: Hotel / Meal.
- Title.
- Linked itinerary item.
- Provider.
- Booking reference.
- Status.
- Cancellation deadline date/time.
- Cancellation policy note.
- Price.
- Currency.
- Notes.

For Meal type, optionally include:

- Reservation time.
- Party size.

For Hotel type, optionally include:

- Start date.
- End date.

Keep the form compact and mobile-friendly.

---

# Navigation / screen placement

Add a way to access Cancellation Deadlines without cluttering the existing app.

Acceptable options:

1. Add it as a new tab/screen alongside existing main views.
2. Add a dashboard button/card near the trip header.
3. Add it in a menu if the app already has one.

Prefer simple and discoverable.

Display a badge/count if there are urgent deadlines:

- Number of due soon or overdue bookings.
- Keep it subtle.

---

# Detailed behavior

## Add booking option from itinerary item

From a Hotel or Meal-related itinerary item, user should be able to add a booking option.

Possible entry points:

- Long-press quick actions menu: `Manage booking options`.
- Item detail view: `Booking options` section.
- Cancellation screen: `Add booking` button.

Choose the simplest high-quality path based on current app structure.

## Mark active

When a booking option is marked active:

- Set selected booking status to `active`.
- For other linked non-cancelled options with the same `linkedItemId`, set status to `tentative`.
- Do not automatically delete or cancel others.

## Mark cancelled

When a booking option is marked cancelled:

- Set status to `cancelled`.
- Keep it visible in the item stack if useful, but visually de-emphasized.
- In Cancellation Deadlines screen, hide cancelled by default or move them to a collapsed/completed area.

## Deadline states

Visual states:

- Overdue: deadline passed and not cancelled.
- Due soon: within 24 hours.
- Upcoming: within 7 days.
- Later: more than 7 days.
- No deadline: no cancellationDeadline.

Use text labels and subtle styling. Do not use loud warning colors everywhere.

---

# Acceptance tests

## Booking options stack

- Add multiple hotel booking options to one hotel item.
- The itinerary card shows a compact summary like `3 booking options`.
- The next cancellation deadline is shown correctly.
- Opening stack shows all linked options.
- Mark one option active; other non-cancelled linked options become tentative.
- Mark one option cancelled; it no longer appears as active/tentative.
- Viewer can view stack but cannot edit.

## Cancellation Deadlines screen

- Bookings with deadlines appear sorted by nearest deadline.
- Overdue booking is clearly marked.
- Booking due within 24 hours is clearly marked.
- Booking due within 7 days is shown as upcoming.
- Cancelled booking is not shown in active deadline list, or is clearly separated.
- Mark cancelled from deadline screen works for owner/editor.
- Viewer cannot mark cancelled.

## Persistence

- Add booking option, reload, booking persists.
- Edit booking option, Save, reload, changes persist.
- Edit booking option, Cancel, reload, changes do not persist.
- Mark active/cancelled, reload, status persists.

## Firestore/security

- Owner/editor can create/update booking options.
- Viewer cannot create/update booking options.
- Non-member cannot read booking options.
- Firestore rules still allow normal days/items writes.
- Firestore rules now allow bookingOptions map.

## Regression

- Existing itinerary items still work.
- Timeline sorting still works.
- Save/Cancel item editing still works.
- Long-press quick actions still work.
- Google Maps action still works.
- Flight items remain time-only and skipped by map routing.
- Weather still works.
- Generated hotel carry-over still works.
- `npm run build` passes.

---

# Commit rules

Implement this Run C in small commits. Suggested commits:

```bash
git add .
git commit -m "Add booking options data model"

git add .
git commit -m "Add booking options stack UI"

git add .
git commit -m "Add cancellation deadline dashboard"

git add .
git commit -m "Update booking option rules and regression polish"
```

If the implementation is smaller, fewer commits are acceptable, but avoid one huge unreviewable commit.

---

# Final output expected from Codex

At the end, provide:

- Commits created.
- Files changed.
- Build/test commands run.
- Any remaining risks.
- Firestore deployment reminder:

```bash
firebase deploy --only firestore:rules
```

- Any Vercel environment changes needed. This feature should not require new env vars unless Codex intentionally adds an external reminder integration, which it should not do in Run C.

---

# Full Run C prompt to paste into Codex

```txt
Read these files first:

1. docs/codex-enhancement-implementation-pack.md
2. docs/codex-save-cancel-form-addendum.md
3. docs/codex-run-c-booking-options-deadlines.md

Assume Run A and Run B have already been completed and merged.

Implement Run C only: Booking Options Stack + Cancellation Deadline Dashboard.

Do not revisit or rewrite Run A/B features unless needed for clean integration.

Core requirements:
- Add booking options for hotel and meal reservations.
- Allow multiple booking options linked to one itinerary item.
- Show clean stack summary on linked itinerary cards.
- Allow free-cancellation deadline date/time.
- Add a Cancellation Deadlines screen sorted by urgency.
- Support statuses: active, tentative, cancelled.
- Derive overdue/deadline states from cancellationDeadline.
- Use Save / Cancel draft editing for booking option forms.
- Owner/editor can edit booking options.
- Viewer can view only.
- Non-members cannot read.
- Update Firestore sync and rules to include bookingOptions.
- Do not implement push notifications, email reminders, OCR, booking email import, or Google Calendar sync.
- Do not introduce unrelated redesign.
- Keep existing visual style.
- Run npm run build and fix errors.

Suggested commit sequence:
1. Add booking options data model.
2. Add booking options stack UI.
3. Add cancellation deadline dashboard.
4. Update booking option rules and regression polish.

Acceptance tests:
- Add multiple hotel booking options to one hotel item.
- Itinerary card shows booking options count and next deadline.
- Mark one option active; other linked non-cancelled options become tentative.
- Mark option cancelled; it is removed/de-emphasized in active deadline tracking.
- Cancellation Deadlines screen sorts nearest deadlines first.
- Overdue and due-soon bookings are clearly marked.
- Save persists booking edits; Cancel discards them.
- Viewer cannot edit booking options.
- Owner/editor can edit booking options.
- Firestore rules allow bookingOptions while protecting member access.
- npm run build passes.

At the end, summarize commits, files changed, build/test commands, remaining risks, and remind me to deploy Firestore rules if changed.
```
