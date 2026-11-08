# Intimora User System — Complete Concept

## 1. Login System — Sign In with Google (Firebase)

### Flow:
```
User clicks "Sign in with Google"
    ↓
Firebase auth → Google OAuth
    ↓
Email received → Check if email exists in Telegram DB
    ↓
┌─── YES (existing user) ──→ Go to site directly
│
└─── NO (new email) ──→ Redirect to "Complete Profile" page
        ↓
    Enter name
        ↓
    Check username availability (Telegram channel)
        ↓
    Optional: Enter referral code (with Skip button)
        ↓
    Generate referral code → Save user to Telegram → Go to site
```

### User Data Stored in Telegram:
- Text message in `users` channel — JSON format
- No Firestore, no SQLite — Telegram hi database

### User JSON:
```json
{
  "t": "user",
  "email": "user@gmail.com",
  "name": "John Doe",
  "username": "johndoe",
  "uid": "firebase-uid-xxx",
  "referralCode": "REF-ABC123",
  "referredBy": "REF-XYZ789",
  "likedVideos": ["vid-1", "vid-2"],
  "savedVideos": ["vid-3"],
  "avatar": "https://...",
  "createdAt": 1234567890
}
```

---

## 2. Telegram Channels Needed

### Existing:
| Channel | Purpose |
|---------|---------|
| Video Channel | Video files |
| Thumbnail Channel | Thumbnail images |
| Metadata Channel | Video metadata |

### New:
| Channel | Purpose |
|---------|---------|
| **Users Channel** | User accounts (email, name, username, referral) |
| **Referrals Channel** | Referral tree (who referred whom) |

### Users Channel format:
```
{"t":"user","email":"...","name":"...","username":"...","referralCode":"...","referredBy":"..."}
```

### Referrals Channel format:
```
{"t":"ref","ownerCode":"REF-AAA","referredCode":"REF-BBB","timestamp":1234567890}
```

---

## 3. Username System

### Flow:
1. User enters name → auto-generate username (lowercase, no spaces)
2. Check Users Channel — username exists?
3. If exists → show "Username already exists" error
4. If not → save username

### Telegram Channel for Usernames:
- Usernames logged in Users Channel
- "New user: John Doe (johndoe)"

---

## 4. Referral System

### Flow:
```
New user signs up → Profile page
    ↓
    "Referral Code (optional)" field + Skip button
    ↓
┌─── Entered code → Validate → Save referredBy
│
└─── Skipped → referredBy = null
    ↓
Generate own referral code → Done
```

### Referral Code Format: `REF-XXXXXX`
- Random 6 characters
- Fixed per user — never changes
- Generated at profile completion

### Referral Tree (Telegram-based):
```
User A (REF-AAA)
├── User B (referred by A, REF-BBB)
│   ├── User C (referred by B, REF-CCC)
│   └── User D (referred by B, REF-DDD)
└── User E (referred by A, REF-EEE)
```

### Dashboard View:
- **Level 1**: Direct referrals (used my code)
- **Level 2**: Referrals of my referrals
- **Not shown**: Who referred me

### Example:
```
Me (REF-AAA)
├── B (REF-BBB) — joined via my code
│   ├── C (REF-CCC) — joined via B's code
│   └── D (REF-DDD) — joined via B's code
└── E (REF-EEE) — joined via my code

Dashboard shows:
  Direct: B, E
  B's referrals: C, D
  E's referrals: (none)

Dashboard does NOT show:
  Who referred me (my referrer)
```

---

## 5. Video Features

### Like Video (Signed-in users only):
```
POST /api/videos/:id/like
→ Toggle like (like/unlike)
→ Update video's likes count
→ Update user's likedVideos array in Telegram
```

### Save Video (Signed-in users only):
```
POST /api/videos/:id/save
→ Toggle save (save/unsave)
→ Update user's savedVideos array in Telegram
```

### Anonymous users:
- Can browse videos ✅
- Can watch videos ✅
- Cannot like/save ❌ → Redirect to login

### Routes:
- `GET /api/user/liked` — User's liked videos
- `GET /api/user/saved` — User's saved videos

---

## 6. Firebase Config

### Frontend (client-side):
```javascript
// firebase-config.js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "intimora-app.firebaseapp.com",
  projectId: "intimora-app",
  storageBucket: "intimora-app.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};
```

### Backend (server-side):
```
// .env file
FIREBASE_PROJECT_ID=intimora-app
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
FIREBASE_CLIENT_EMAIL="firebase-adminsdk@intimora-app.iam.gserviceaccount.com"
```

### Setup Steps:
1. Google Cloud Console → Create project → Enable Google Sign-In
2. Firebase Console → Create project → Add Web app
3. Firebase Auth → Enable Google provider
4. Service Account → Generate private key → Add to backend .env

### Cost: ₹0/month
- Firebase Auth: Free (unlimited users)
- Telegram API: Free (unlimited)
- No Firestore needed

---

## 7. Backend Routes

```
POST   /api/auth/verify      → Verify Firebase token
POST   /api/auth/profile     → Complete profile (name, username, referral)
GET    /api/auth/me          → Get current user
POST   /api/auth/logout      → (optional)

POST   /api/videos/:id/like  → Toggle like
POST   /api/videos/:id/save  → Toggle save

GET    /api/user/liked       → User's liked videos
GET    /api/user/saved       → User's saved videos

GET    /api/user/referrals   → Referral tree (direct + level 2)
```

---

## 8. Implementation Order

1. Create Telegram channels (Users + Referrals)
2. Firebase setup (project, config, service account)
3. Frontend login (Sign in with Google)
4. Backend token verification (Admin SDK)
5. Profile completion (name, username, referral)
6. Referral system (codes, tree, dashboard)
7. Video features (like, save, user routes)
8. Username logging to Telegram

---

## 9. Questions for User

1. **Firebase project name?** — "intimora-app" ya aapka pasand?
2. **Username** — name se auto-generate karna ya manually enter karna?
3. **Referral code format** — `REF-XXXXXX` ya simple `XXXXXX`?
4. **Telegram channel names** — Users channel aur Referrals channel ka name?

---

## 10. Summary

| Feature | Frontend | Backend | Telegram | Firebase |
|---------|----------|---------|----------|----------|
| Sign in with Google | ✅ | ✅ (verify token) | — | ✅ Auth |
| Profile completion | ✅ | ✅ | ✅ Users channel | — |
| Referral system | ✅ | ✅ | ✅ Referrals channel | — |
| Like/Save videos | ✅ | ✅ | ✅ Users channel | — |
| Referral dashboard | ✅ | ✅ | ✅ Referrals channel | — |
| Username logging | — | ✅ | ✅ Users channel | — |

**No Firestore — Telegram hi database.**
**Cost: ₹0/month.**
