# Feature gaps

What WABridge doesn't support yet, compared with what WhatsApp offers. Written 2026-11-18.

**Progress (2026-11-18, all deployed and tested live, committed on branch feat/parity-1-4):**
- #1 edit, delete, forward (+ star): `POST /api/messages/edit|delete|forward|star`.
- #2 location, contact cards, sticker, videoNote: on `/api/reply` and `/api/messages`.
- #3 groups: `GET/POST /api/groups/join`, `POST /:id/leave`, `DELETE /:id/invite`, `GET/POST /:id/requests`, `joinApproval` setting. Only the read calls were tested live (writes would touch client groups).
- #4 `PATCH /api/chats/:id` (pin, archive, mute, read, disappearing), `PUT /api/chats/disappearing-default`.
- #5 `GET/PATCH /api/profile`, `/picture`, `PATCH /api/profile/business`, `PUT /api/profile/business/cover` (also covers the account's own name, about and picture). Only reads tested live: writes are public to clients' customers.
- #6 `/api/contact-tags` (old `/api/labels` still works, sends a Deprecation header); `POST /api/status`, `DELETE /api/status/:id`.
- Still open: group write calls (join, leave, revoke, approve) untested live; SSRF on every URL the bridge fetches (media, pictures, cover).

All of it belongs in the open-source base. None of it is private, so it doesn't go in an extension.

## Most useful (proposed build order)

| # | Feature | What it lets a client do | Notes |
|---|---------|--------------------------|-------|
| 1 | Edit and delete sent messages | Fix a typo, or unsend a message for everyone | Only polls can be deleted today. Generalise that. |
| 1 | Forward a message | Pass a received message on to another chat or group | |
| 2 | Location, contact cards, stickers, round video notes | Send a clinic's location or a doctor's contact card | The contact-check extension can already send a card, but the core API can't. These are new send types on the existing send path. |
| 3 | Groups: leave, join by invite link, preview an invite, approve or reject join requests, revoke the invite link | Fills the group gaps | Today a group can be created and managed, but not left, and join requests can't be approved. |
| 4 | Pin, star, archive, mute, mark read or unread | Tidy the business phone's chat list, e.g. archive finished conversations or pin VIPs | |
| 4 | Disappearing messages | Turn on 24 h / 7 d / 90 d timers per chat or group, or as the default | |
| 5 | Business profile | Read or update the description, hours, address, website and cover photo | |

## Clean-ups to do at the same time (#6)

- **`/api/labels` vs `/api/lists`:** `/api/labels` is the bridge's own contact tagging, not WhatsApp's labels, and it's easily confused with the newer `/api/lists`. Rename or deprecate it.
- **Status posts:** these exist only inside the private contact-check extension. Add a general status-post API to the base, and keep only the contact-check behaviour in the extension.

## Useful in some cases (wait until a client asks)

- **Communities:** create one, link and unlink groups, announcements.
- **The account's own profile:** display name, about text and profile picture. Group pictures already work, but the number's own picture doesn't.
- **Privacy settings:** last seen, online status, read receipts, who can add the number to groups.
- **Blocking:** block or unblock a number, and fetch the block list.
- **Channels:** create, post to, follow and react. Channels are a different product from conversations.
- **Product catalogue and orders:** a WhatsApp Business shop. A big job, and only useful for e-commerce clients.
- **WhatsApp Business labels on messages:** overlap with the chat lists we've already built.
