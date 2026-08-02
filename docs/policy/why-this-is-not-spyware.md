# Why notification access in this app is not spyware

Audience: Google Play policy review, the permissions declaration, and the Data Safety rationale.
Scope: Android v1. Last reviewed: 2026-08-03.
Engineering detail: [`../research/2026-08-02-app-layers.md`](../research/2026-08-02-app-layers.md) §5.2, [`../research/data-layer/01-decisions.md`](../research/data-layer/01-decisions.md) D57.

## What the app does

It is a personal expense manager. It reads transaction alerts that the user's own bank posts as notifications, extracts the amount, currency, merchant and date, and records them as expenses the user reviews and confirms.

Extraction runs **entirely on the device**, using a language model bundled with the app. **No server receives captured content.** The app has no account and no login, and there is no backend that transaction data is sent to. The app's small number of outbound requests are listed in full under "Network activity" below.

## Why notification access is the core functionality

Manual expense entry fails because people do not do it. The product is the automatic capture of bank transaction alerts; without notification access there is no product, only another manual ledger.

`NotificationListenerService` is used instead of `READ_SMS` deliberately: most banks in the target market now deliver transaction alerts through their own app rather than SMS, and notification access avoids requesting the broader SMS permission group. `READ_SMS` is **not present in the v1 manifest at all**.

## Five properties, each verifiable in the code

**1. Non-bank notifications are discarded before they are read.**
The first statement in `onNotificationPosted` compares the posting package against a signed allowlist of financial institutions and returns. This happens before any field is copied out of the callback, before any persistence, before any logging. There is no wildcard match, no regex over package names, and no mode that learns new senders. A notification from a messaging, dating, health or any other app is never read, never stored, and never leaves the callback.

**2. Nothing captured is transmitted anywhere.**
v1 has no network destination for captured content. No analytics SDK, no ad SDK, no third-party inference API, no sync service. This is not a policy promise layered over a capable system — the capability does not exist in the build.

**3. The app executes no code it receives from a network.**
The app does fetch a small, signed configuration file — the list of financial institutions to capture from, and operational settings such as which device classes may use GPU acceleration. That file is **data**: it is signature-verified, parsed into a fixed schema, and can only populate values the app already understands. It cannot introduce a command, a tool call, or executable code, and it cannot widen what the app captures beyond the institution category. Currency reference rates are handled the same way.

We state the channel plainly rather than claiming none exists, because one does and a reviewer inspecting traffic will see it. What does not exist is any path by which a remote party can make this app run code or perform an operation the user did not initiate.

**4. The app is always visible as itself.**
Unique launcher icon, app name always displayed, no activity-alias icon hiding, an in-app indicator whenever capture is enabled, and an ongoing status notification while it is active. The user cannot be unaware the app is running, and nothing about it is designed to be inconspicuous.

**5. The data stays under the user's control and can be destroyed.**
The database is encrypted at rest. The user can review every captured item, delete any of it, and erase everything from within the app. Uninstalling removes it all; there is no copy elsewhere because no copy was ever made.

## What the app never does

- Read notifications or messages from non-financial apps.
- Read personal SMS. The permission is not requested.
- Send message content, contacts, call logs, location, or device identifiers off the device.
- Use captured data for advertising, profiling, or any purpose other than showing the user their own expenses.
- Sell or share data with third parties. There are no third parties.

## Data Safety

The app **does not collect** data as Play defines collection: no captured content is transmitted off the device. Financial data is processed on-device only.

### Network activity — the complete list

Three outbound paths exist. None carries captured content, and none is omitted here.

| Path | Direction | Carries user data? |
| --- | --- | --- |
| **Model download** (Play Asset Delivery) | inbound | No. Play serves the model file; the request says nothing about the user |
| **Currency reference rates** | inbound | No. Asks a public source for published exchange rates |
| **Signed configuration** (institution list, operational settings) | inbound | No. Fetches a signed file; sends nothing about the user |
| **Crash reporting** | outbound | **Opt-in, off by default.** Carries no notification content, no message bodies, no transaction values |

Crash reporting is the only path that transmits anything at all, and it is disabled unless the user turns it on.

## Verifying these claims

We will provide, on request: a screen recording of the capture flow end to end; the allowlist filter with its surrounding code; a network capture over a full session showing no outbound traffic carrying captured content; and a build in which a reviewer can inject synthetic bank notifications via `adb` to exercise the flow without a real bank account.

That last item matters — a reviewer cannot receive genuine bank alerts on a test device, so the app ships a documented way to demonstrate the functionality without one.
