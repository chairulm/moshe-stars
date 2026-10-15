// Paste your Firebase web app config here (Firebase console → Project settings → Your apps → Web app).
// These values are public identifiers, not secrets. Security comes from firestore.rules.
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

// Internal login addresses use this made-up domain. No email is ever sent.
export const LOGIN_DOMAIN = "moshe-stars.example";
