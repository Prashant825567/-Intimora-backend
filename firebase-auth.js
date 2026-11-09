// Firebase Auth Utility — for frontend
// Place this file in your frontend project and import where needed

import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";

// ---- Firebase Config (from Firebase Console) ----
const firebaseConfig = {
  apiKey: "AIzaSyD91f9kLylYXZnZjPSZOfjk1HFJ0Y-v7Yo",
  authDomain: "intimora-app.firebaseapp.com",
  projectId: "intimora-app",
  storageBucket: "intimora-app.firebasestorage.app",
  messagingSenderId: "304602370239",
  appId: "1:304602370239:web:5009a41ba304f6a2c9760a",
  measurementId: "G-P47TZGBPV8",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ---- Sign in with Google ----
export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    const user = result.user;
    const idToken = await user.getIdToken();

    // Send token to backend for verification
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken,
      },
    });
    const data = await res.json();

    return { user, ...data.data };
  } catch (e) {
    throw new Error('Sign in failed: ' + e.message);
  }
}

// ---- Sign out ----
export async function signOutUser() {
  await signOut(auth);
}

// ---- Get current user's ID token ----
export async function getIdToken() {
  const user = auth.currentUser;
  if (!user) return null;
  return await user.getIdToken();
}

// ---- Get current user ----
export function getCurrentUser() {
  return auth.currentUser;
}

// ---- Auth state listener ----
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, (user) => {
    callback(user);
  });
}

// ---- API helper with auth token ----
export async function apiCall(url, options = {}) {
  const token = await getIdToken();
  const headers = {
    ...options.headers,
    ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
  };
  return fetch(url, { ...options, headers });
}

// ---- Complete profile ----
export async function completeProfile({ name, username, referralCode, avatar }) {
  const token = await getIdToken();
  const res = await fetch('/api/auth/profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({ name, username, referralCode, avatar }),
  });
  return res.json();
}

// ---- Like / Unlike video ----
export async function toggleLike(videoId) {
  return apiCall('/api/videos/' + videoId + '/like', { method: 'POST' });
}

// ---- Save / Unsave video ----
export async function toggleSave(videoId) {
  return apiCall('/api/videos/' + videoId + '/save', { method: 'POST' });
}

// ---- Get user's liked videos ----
export async function getLikedVideos() {
  const res = await apiCall('/api/user/liked');
  return res.json();
}

// ---- Get user's saved videos ----
export async function getSavedVideos() {
  const res = await apiCall('/api/user/saved');
  return res.json();
}

// ---- Get referral tree ----
export async function getReferralTree() {
  const res = await apiCall('/api/user/referrals');
  return res.json();
}

export { auth };
