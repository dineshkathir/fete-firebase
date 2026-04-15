# eventise Android TWA

This folder contains a starter Android app shell for publishing the existing `eventise` web app to Google Play using a Trusted Web Activity (TWA).

## Before opening in Android Studio

1. Deploy the web app to your final HTTPS domain.
2. Update `app/src/main/res/values/strings.xml`:
   - replace `https://YOUR_DOMAIN/` with your real production URL
3. Generate your Play signing certificate SHA-256.
4. Replace the placeholder fingerprint in `public/.well-known/assetlinks.json`.
5. Deploy Hosting again so `https://YOUR_DOMAIN/.well-known/assetlinks.json` is live.

## Open and build

1. Open the `android-twa` folder in Android Studio.
2. Let Android Studio sync Gradle dependencies.
3. Update `applicationId` / package name if you want a different Play Store package.
4. Build:
   - Debug APK for local testing
   - Release AAB for Play Store upload

## What is included

- `LauncherActivity` using `android-browser-helper`
- app icon and splash drawable
- launch URL metadata
- basic theme colors matching the web app

## Important notes

- TWA requires the web app to remain installable, so keep:
  - `public/site.webmanifest`
  - `public/sw.js`
  - valid app icons
- The website and Android app must trust each other through Digital Asset Links.
- Google sign-in should work best on the production hosted domain, not from local file previews.
