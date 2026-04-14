# fête – Deploy to Netlify (Free)

## What's included
- `index.html` — the full app (auth + cloud data)
- `netlify.toml` — Netlify SPA routing config
- `README.md` — this guide

Data is stored in **Firebase Firestore** (free tier). Auth supports Email/Password + Google Sign-In.

---

## Step 1 — Create a free Firebase project (5 min)

1. Go to **https://console.firebase.google.com** → **Add project**
2. Enter a project name (e.g. `fete-app`) → Continue → Disable Google Analytics (optional) → Create project
3. In the left sidebar click **Build → Authentication → Get started**
   - Enable **Email/Password**
   - Enable **Google** (add your support email when prompted)
4. In the left sidebar click **Build → Firestore Database → Create database**
   - Choose **Start in production mode** → Next
   - Pick a region (e.g. `asia-south1` for India) → Enable
5. In the left sidebar click **Build → Firestore Database → Rules** tab, paste:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       // Users can read/write their own profile
       match /users/{uid} {
         allow read, write: if request.auth.uid == uid;
       }
       // Events: members can read; organizer can write
       match /events/{eventId} {
         allow read: if request.auth.uid in resource.data.members;
         allow create: if request.auth != null;
         allow update, delete: if request.auth.uid in resource.data.members
           && resource.data.teamRoles[request.auth.uid] == 'organizer';
       }
       // Guests: event members can read/write
       match /guests/{guestId} {
         allow read, write: if request.auth != null;
       }
       // Gifts: event members can read/write
       match /gifts/{giftId} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
   → **Publish**

6. In the left sidebar click **Project Overview (gear icon) → Project settings**
   - Scroll to **Your apps** → click the **</>** (Web) icon
   - App nickname: `fete-web` → **Register app**
   - Copy the `firebaseConfig` object shown

---

## Step 2 — Add your Firebase config to index.html

Open `index.html` and find this section (around line 580):

```js
const firebaseConfig = {
  apiKey: "AIzaSyPLACEHOLDER_REPLACE_ME",
  authDomain: "your-project.firebaseapp.com",
  ...
};
```

Replace it with **your actual config** copied from Firebase. It looks like:

```js
const firebaseConfig = {
  apiKey: "AIzaSyABCDEF...",
  authDomain: "fete-app-12345.firebaseapp.com",
  projectId: "fete-app-12345",
  storageBucket: "fete-app-12345.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};
```

---

## Step 3 — Deploy to Netlify (2 min)

**Option A — Drag & Drop (easiest)**
1. Go to **https://app.netlify.com** → Log in / Sign up free
2. Click **Add new site → Deploy manually**
3. Drag the entire `fete-app` folder onto the upload area
4. Done! Netlify gives you a live URL like `https://random-name.netlify.app`

**Option B — GitHub (for automatic deploys)**
1. Push this folder to a GitHub repo
2. In Netlify: **Add new site → Import an existing project → GitHub**
3. Select your repo → **Deploy site**
4. Every `git push` auto-deploys

---

## Step 4 — Add your Netlify domain to Firebase

After deploying, copy your Netlify URL (e.g. `https://fete-app.netlify.app`).

In Firebase Console:
- **Authentication → Settings → Authorized domains**
- Click **Add domain** → paste your Netlify URL → **Add**

This is required for Google Sign-In to work on your live site.

---

## Features
- ✅ Email + Google Sign-In (real accounts)
- ✅ Cloud data storage (Firestore) — syncs across devices
- ✅ Real-time updates (guests/gifts update live)
- ✅ Events, Guests, Gifts, Moi, Rooms
- ✅ Role-based access (Organizer / Cash Collector / Room Coordinator)
- ✅ Team collaboration (invite by email)
- ✅ WhatsApp Thank-You messages
- ✅ CSV export
- ✅ Photo upload for gifts (stored as base64)
- ✅ Room assignment & conflict detection
- ✅ Offline-first feel with Firestore caching

## Free tier limits (Firebase Spark plan)
- 50,000 reads/day · 20,000 writes/day · 1 GB storage
- More than enough for personal event management
