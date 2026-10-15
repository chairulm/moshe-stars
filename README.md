# Moshe's Star Chart

A small installable web app (PWA) for Moshe's weekday routine. Moshe ticks his own tasks and can add a photo as evidence. Dad reviews each box, and can change the score with a reason. The week's star total unlocks weekend rewards.

- Opens in any phone browser and can be added to the home screen. No app store needed.
- Moshe and Dad each have their own login. Moshe can change his own password. Dad can't log in as Moshe, but can reset Moshe's password.
- Data is stored in Firebase (Firestore) and syncs live between phones. It also works offline and syncs when the phone is back online.
- Hosted on the VPS at https://moshe.ch-41.com (nginx, static files). Firebase SDK and fonts are vendored in `vendor/`, so no CDN is needed.

## Rewards and tasks

Edit `GROUPS` and `REWARDS` at the top of `app.js`.

| Stars | Reward |
|---|---|
| 30 | 1 hr Nintendo / TV on the weekend |
| 38 | 1 hr Nintendo / TV + IDR 25rb |
| 42 | Trip to the playground |

## One-time setup (about 15 minutes)

### 1. Firebase project
1. Go to https://console.firebase.google.com and click **Create a project**, e.g. `moshe-stars`. Google Analytics is optional; you can turn it off. The free Spark plan is enough.
2. Go to **Build → Authentication → Get started → Sign-in method** and enable **Email/Password**.
3. Go to **Build → Firestore Database → Create database**. Choose a location near you (e.g. `asia-southeast2` Jakarta) and **production mode**.
4. In Firestore, open the **Rules** tab, paste in the contents of `firestore.rules`, and click **Publish**.
5. Go to **Project settings (gear) → General → Your apps → Web (`</>`)**. Register the app (Hosting is not needed), then copy the `firebaseConfig` values into `firebase-config.js`.

### 2. Deploy to the VPS
DNS first: add an A record for `moshe.ch-41.com` pointing to the VPS IP.

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/chairulm/moshe-stars.git && cd moshe-stars
sudo bash deploy/precheck.sh --domain moshe.ch-41.com            # read-only; fix any FAIL
sudo bash deploy/install.sh --domain moshe.ch-41.com --email chairul.manalu@gmail.com
sudo bash /opt/moshe-stars/deploy/check.sh
```
Updates: `cd ~/moshe-stars && git pull && sudo bash deploy/install.sh && sudo bash /opt/moshe-stars/deploy/check.sh`

`install.sh` is idempotent. It copies the site to `/opt/moshe-stars/www`, adds its own nginx site (not `default_server`, so other sites on the VPS are untouched), opens SSH/80/443 in ufw, enables fail2ban, gets a Let's Encrypt certificate, and stamps the service-worker version with the git commit so phones update.

### 3. Allow the domain in Firebase
Go to **Authentication → Settings → Authorized domains → Add domain** and add `moshe.ch-41.com`.

### 4. First run (do this right away)
1. Open the app URL. The **First-time setup** screen appears.
2. Enter Dad's password (twice) and a starting password for Moshe, then tap **Create accounts**.
3. Do this immediately after deploying. Whoever completes setup first becomes Dad.

### 5. Install on phones
- **Android (Chrome):** open the URL, tap ⋮, then **Add to Home screen / Install app**.
- **iPhone (Safari):** open the URL, tap Share, then **Add to Home Screen**.

Moshe logs in on his phone or tablet by tapping **Moshe** and typing his password. You log in on yours by tapping **Dad**. Each device stays logged in until someone taps **Log out**.

## How it works

| Who | Can do |
|---|---|
| Moshe | Tick "I did it" / "Not done" for **this week, today and earlier days only**; add or remove a photo; change his own password |
| Dad | See every box with Moshe's check and photo; score is prefilled from Moshe's; save it as is or change it (a reason is required when it differs); remove a score; browse past weeks; reset Moshe's password |

- Total stars per box: Dad's score if he saved one, otherwise Moshe's own.
- Badges: blue dot = photo added, green ✓ = Dad gave a star, red ✕ = Dad said no star.
- **Reset Moshe's password** (Dad → Change password) creates a fresh login for Moshe. His stars and photos are kept, and the old login stops working. You can delete old `moshe-…` users in Firebase Authentication whenever you like.

## Security notes

- `firebase-config.js` holds public identifiers, not secrets. Committing it to a public repo is normal for Firebase web apps. Access is enforced by `firestore.rules`:
  - Only the Dad and Moshe accounts listed in `meta/roles` can read anything.
  - Only Moshe can write his ticks and photos. Only Dad can write scores and reasons.
- Logins use made-up internal addresses (`dad@moshe-stars.example`, `moshe-…@moshe-stars.example`), so no real email is involved. Because of that, "forgot password" emails can't be sent. If **Dad** forgets his password: in the Firebase console, delete the `dad@…` user (Authentication) and the `meta/roles` and `meta/login` documents (Firestore), then run first-time setup again. Stars and photos are kept.
- Photos are shrunk to about 1100 px and stored in Firestore, so no paid Storage plan is needed. The free tier holds thousands of them.

## Updating the app

Change the files, commit, push, then run the update command above on the VPS. Phones pick up the new version the next time the app is opened online.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | The app |
| `firebase-config.js` | Your Firebase project config |
| `firestore.rules` | Database security rules (paste into the console, or `firebase deploy --only firestore:rules`) |
| `manifest.webmanifest`, `sw.js`, `icons/` | Install-to-home-screen and offline support |
| `deploy/precheck.sh`, `deploy/install.sh`, `deploy/check.sh` | Server check, installer, health report |
| `vendor/` | Firebase SDK 10.12.2 and fonts (self-hosted) |
