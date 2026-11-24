# Password reset by the Super Admin

An organization administrator who forgets the password of their portal asks the platform owner. In the **Super Admin portal** (Organizations > Administrators) every administrator who has activated their account has a **Reset password** button.

## What happens

1. The Super Admin presses **Reset password** and confirms ("their current password stops working at once and everyone signed in as them is signed out").
2. The Organization Service asks the Auth Service to reset that administrator. The Auth Service generates a strong **temporary password** (16 characters from the operating system's secure generator: at least 3 capitals, 4 lowercase, 3 digits and 2 symbols, nothing that looks alike such as `0 O 1 l I`, nothing that breaks the portal's own rules or contains part of the email address) and makes it the account's password. Only its hash is stored.
3. The Organization Service **emails it to the address the administrator registered with** (the same SMTP settings as every other email), with the sign-in link, the 24-hour limit and the instruction to choose a new password. The Super Admin is told only *where* it was sent and until when; the password is never in an answer, never logged and never shown.
4. The administrator signs in with it. The portal sends them straight to **Choose a new password** (`/change-password`); every other page of the portal sends them back there until they have chosen their own (`must_change_password`). The rules tick off as they type (8+ characters, lowercase, uppercase, digit, symbol, no part of the email), the new password must differ from the temporary one, and the Auth Service checks all of it again.
5. Choosing a new password ends the temporary one for good and the portal opens.

## Safety rules

* Only a Super Admin can do it, and only for an administrator of the named organization who has **activated their account** (a pending invitation has no password: *Resend invitation* is the way). A Super Admin, another organization's administrator and a disabled account cannot be reset.
* **Every older sign-in ends** (each token carries a password version; services ask the Auth Service who a token belongs to, so every service refuses it): a forgotten or stolen password cannot keep a session alive.
* A temporary password that is never used **expires after 24 hours** (the sign-in says "Your temporary password has expired. Ask your administrator to send you a new one."). A reset cannot be sent again within **a minute**.
* If the email cannot be sent the Super Admin is told so plainly: the account already has the new password, which nobody has seen, so pressing **Reset password** again (after a minute) sends a fresh one.
* The forced change is enforced by the portal on every page; the services behind it do not refuse a token on a temporary password, which is why it is short-lived and replaced at the first sign-in.

## Where it lives

* Auth Service: migration `0007` (`must_change_password`, `password_changed_at`, `password_reset_expires_at`, `password_reset_sent_at`), `app/password_reset.py`, `POST /internal/organization-admins/reset-password` (service key only), `POST /api/v1/auth/me/password` (a person's own change; returns a fresh sign-in).
* Organization Service: `POST /api/v1/organizations/{org}/administrators/{admin}/reset-password` (Super Admin only), `app/mailer.py: build_password_reset_message`.
* Super Admin portal: `Reset password` in `administrator-actions.tsx`, route `/api/administrators/[id]/reset-password`.
* Organization portal: `/change-password`, route `/api/auth/change-password`, the sign-in route/form pass `mustChangePassword`, `loadWorkspace` redirects.
* Tests: Auth `tests/test_password_reset.py`; Organization `tests/test_password_reset.py`; portals `password-reset-flow.test.tsx` and `administrator-reset-ui.test.tsx` / `administrators.test.ts`.
