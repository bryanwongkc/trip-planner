# Codex Addendum — Button-driven item detail saving

Read this together with `docs/codex-enhancement-implementation-pack.md`.

This addendum adds one important UX/data-sync requirement: item detail editing must no longer auto-save every field change to Firestore. Editing should be draft-based and only persisted when the user presses Save.

## Problem

The current detail/edit form appears to auto-save changes to Firestore as the user types or changes fields. This creates several problems:

- Accidental edits are immediately persisted.
- User cannot safely explore changes and discard them.
- Firestore receives unnecessary writes.
- Timeline/order changes can persist before the user has finished editing.
- Collaboration later becomes harder because every keystroke becomes a shared update.

## New rule

All item detail editing must be button-driven:

```txt
Open item detail/edit form
→ copy item into local draft state
→ user edits fields locally only
→ Save button persists changes to app state / Firestore
→ Cancel button discards draft and closes form
```

No field inside the item detail form should directly write to Firestore.

## UX requirements

The edit form/modal/bottom sheet must have two clear actions:

- `Save`
- `Cancel`

Suggested button placement:

- Save: primary button, bottom-right or sticky bottom action.
- Cancel: secondary button, beside Save or top-left close.

Behavior:

- Pressing `Save` applies the draft to the itinerary, normalizes timeline order if needed, closes the form, and allows the existing debounced Firestore sync to persist the change.
- Pressing `Cancel` discards all unsaved draft changes and closes the form.
- Pressing outside the modal/sheet should not silently save.
- Pressing close `X` should behave like Cancel.
- If there are unsaved changes and user tries to close, either:
  - discard immediately with Cancel behavior, or
  - show a small confirmation.
- Prefer simple Cancel behavior first unless a confirmation already exists in the app.

## Implementation direction

Use local draft state:

```js
const [editingItem, setEditingItem] = useState(null)
const [itemDraft, setItemDraft] = useState(null)

function openItemEditor(item) {
  setEditingItem(item)
  setItemDraft(structuredClone ? structuredClone(item) : JSON.parse(JSON.stringify(item)))
}

function updateItemDraft(patch) {
  setItemDraft((current) => ({ ...current, ...patch }))
}

function cancelItemEdit() {
  setEditingItem(null)
  setItemDraft(null)
}

function saveItemEdit() {
  if (!itemDraft) return
  // Apply validation and derived fields here.
  // Then update itinerary state once.
  applyItemPatch(itemDraft)
  setEditingItem(null)
  setItemDraft(null)
}
```

Do not use field-level handlers that directly call the Firestore merge/update logic.

## Integration with Phase 1

This addendum should be implemented in Phase 1 because duration/end-time changes happen inside the item detail form.

Phase 1 must now include:

- Detail form uses local draft state.
- `startTime`, `endTime`, `endTimeMode`, and `durationMinutes` update draft only.
- Derived `endTime` is calculated inside draft state only.
- Timeline order is normalized only after Save.
- Cancel discards duration/time edits.
- Firestore persistence only happens after Save updates the app state.

## Integration with Phase 2

Phase 2 long-press quick action `Edit details` should open the same draft-based editor.

Important:

- Single tap and long-press edit should both open the editor with a local draft.
- Long press should not cause any save.
- Google Maps action should not mutate item data.

## Integration with Phase 3

Flight lookup/editing should also follow button-driven behavior.

When editing a Flight item:

- Looking up flight information may update the local draft first.
- Do not persist the flight lookup result until user presses Save.
- Cancel should discard looked-up flight changes.

If the current app already has an explicit “fetch flight” button, that button may update the draft, but it must not save to Firestore until Save is pressed.

## Integration with Phase 4/5 collaboration

This behavior is important for collaboration:

- Viewer cannot open editable draft mode.
- Editor/owner can edit draft locally.
- Other collaborators should only see the change after Save.
- Avoid writing every keystroke to shared Firestore documents.

## Dirty state helper

Optional helper:

```js
function isDraftDirty(original, draft) {
  return JSON.stringify(original) !== JSON.stringify(draft)
}
```

Use this only if needed to disable Save until something changed.

Recommended Save button behavior:

- Disabled if required fields are invalid.
- Optional: disabled if draft is not dirty.
- Shows validation warning if end time is earlier than start time.

## Required acceptance tests

- Open item detail, edit title, press Cancel → title remains unchanged after closing.
- Open item detail, edit title, press Save → title updates and persists after reload.
- Open item detail, change duration, press Cancel → start/end/duration unchanged.
- Open item detail, change duration, press Save → derived endTime updates and persists.
- Open item detail, change startTime in duration mode, press Cancel → timeline order does not change.
- Open item detail, change startTime in duration mode, press Save → timeline order updates.
- Open Flight item, fetch/modify flight details, press Cancel → no flight changes persist.
- Open Flight item, fetch/modify flight details, press Save → flight changes persist.
- Closing the editor with `X` behaves like Cancel unless a confirmation is implemented.
- `npm run build` passes.

## Updated Phase 1 prompt snippet

When running Codex Phase 1, use this addition:

```txt
Also read docs/codex-save-cancel-form-addendum.md.

Important additional Phase 1 requirement:
Change item detail editing from auto-save to local draft + Save/Cancel.
Fields inside the detail form must not persist immediately to Firestore.
Save applies the draft and persists through existing app state/Firestore sync.
Cancel discards all draft changes.
Timeline reordering and duration-derived endTime should only be committed after Save.
Run npm run build and fix errors.
```
