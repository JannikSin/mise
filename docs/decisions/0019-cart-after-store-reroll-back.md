# 0019. Send the list to the cart after GOING TO THE STORE, and bring the re-roll back

- **Status:** accepted
- **Date:** 2026-10-18
- **Deciders:** David (his answers to the principles check, relayed by weber); built by session monolith; Tribunal final gate 2026-10-18
- **Tenet invoked:** 6 (priced and ready to buy), 1 (choices removed, what remains verified)

## Context

The principles check of 2026-10-18 found tenet 6 the only tenet failing outright: Mise
priced the list but could not put it in the Pay Less cart. Decision 0018 had parked the
cart buttons with the live-price controls, and the cart had never once worked from the app
(the Kroger redirect URI was never registered on David's developer app; the Worker side
was verified ready the same day). David: "I don't want you to order. I just want you to
add it to the cart", and only once the week is set and he is going to the store. Separately,
on 2026-10-17 he asked for "a button that picks different meals if I don't like what I
see", which 0018 had parked.

## Options considered

1. **The app button, after GOING TO THE STORE.** The code existed; one door to reopen.
   Costs his one-time Kroger registration and sign-in. Add-only: never orders, never picks
   a slot.
2. **A script a session runs** (as on 2026-08-19 and 08-25). Needs his Kroger client secret
   copied to whichever machine runs it, and a session every week. Rejected.
3. **Keep it parked; he orders by hand.** Leaves tenet 6 failing.

## Decision

Option 1. The cart row shows on the List only after GOING TO THE STORE has saved the week
(`plan.fallback`). The live-price controls stay parked, renamed from `"kroger"` to
`"liveprices"` so the key no longer suggests the cart is parked. A per-week record of full
sends (`withCartSend`) makes a second full copy of a week need an explicit re-arm, across
reloads, log rotation and a second tap of GOING TO THE STORE. Rows the cart cannot carry
(no product picked at the store) are named on screen so they are bought by hand.

PICK DIFFERENT MEALS is unparked, and shows only BEFORE the week is shopped: a cart pickup
stocks no pantry, so after GOING TO THE STORE a re-roll could not tell bought dinners from
unbought ones (tenet 5).

## Consequences

Buying becomes a pickup for every row with a product picked. What gets worse: the cart is
add-only with no read-back, so a second phone or a cleared browser can still add a second
copy; he sees it in the Pay Less app before paying. P4's cart gap stays open until his
first real send is checked in that app.
