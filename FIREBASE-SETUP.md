# Firebase Setup Guide

## Step 1: Get Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select project **intimora-app**
3. Click **Project Settings** (gear icon)
4. Click **Service Accounts** tab
5. Click **Generate new private key**
6. A JSON file downloads — **don't share this file publicly**

## Step 2: Copy Keys from JSON

From the downloaded JSON file, copy these values:

```json
{
  "type": "service_account",
  "project_id": "intimora-app",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk@intimora-app.iam.gserviceaccount.com",
  ...
}
```

## Step 3: Update Backend `.env`

Replace the placeholders in `.env`:

```
# Firebase Admin SDK
FIREBASE_PROJECT_ID=intimora-app
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@intimora-app.iam.gserviceaccount.com
```

**Important:** The private key must be in escaped format with `\n` for newlines.

## Step 4: Update Vercel Environment Variables

Go to Vercel → Project Settings → Environment Variables → Add:

| Variable | Value |
|----------|-------|
| `FIREBASE_PROJECT_ID` | `intimora-app` |
| `FIREBASE_PRIVATE_KEY` | `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` |
| `FIREBASE_CLIENT_EMAIL` | `firebase-adminsdk@intimora-app.iam.gserviceaccount.com` |

## Step 5: Install firebase-admin on Backend

```bash
npm install firebase-admin
```

## Step 6: Frontend Setup

1. Copy `firebase-auth.js` to your frontend project
2. Import where needed:

```javascript
import { signInWithGoogle, signOutUser, completeProfile, toggleLike, toggleSave } from './firebase-auth';

// Sign in button
async function handleSignIn() {
  const result = await signInWithGoogle();
  if (result.data.exists) {
    // Existing user — go to site
    navigate('/');
  } else {
    // New user — go to profile
    navigate('/profile');
  }
}

// Profile page
async function handleProfile(name, username, referralCode) {
  const result = await completeProfile({ name, username, referralCode });
  if (result.ok) navigate('/');
}

// Like button
async function handleLike(videoId) {
  await toggleLike(videoId);
}

// Save button
async function handleSave(videoId) {
  await toggleSave(videoId);
}
```

## Step 7: Frontend Pages Needed

### Login Page:
```jsx
import { signInWithGoogle } from './firebase-auth';

function Login() {
  const handleSignIn = async () => {
    const result = await signInWithGoogle();
    if (result.data.exists) navigate('/');
    else navigate('/profile');
  };
  return <button onClick={handleSignIn}>Sign in with Google</button>;
}
```

### Profile Page:
```jsx
import { completeProfile } from './firebase-auth';

function Profile() {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [referralCode, setReferralCode] = useState('');

  const handleSubmit = async () => {
    const result = await completeProfile({ name, username, referralCode });
    if (result.ok) navigate('/');
  };

  return (
    <div>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
      <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" />
      <input value={referralCode} onChange={e => setReferralCode(e.target.value)} placeholder="Referral code (optional)" />
      <button onClick={() => setReferralCode('')}>Skip</button>
      <button onClick={handleSubmit}>Complete Profile</button>
    </div>
  );
}
```

### Dashboard (Referrals):
```jsx
import { getReferralTree } from './firebase-auth';

function Dashboard() {
  const [tree, setTree] = useState(null);
  useEffect(() => {
    getReferralTree().then(res => setTree(res.data.tree));
  }, []);

  return (
    <div>
      <h2>Your Referral Code: {tree?.code}</h2>
      <h3>Direct Referrals ({tree?.direct?.length || 0})</h3>
      {tree?.direct?.map(u => <div key={u.uid}>{u.name} ({u.username})</div>)}
      <h3>Level 2 Referrals ({tree?.level2?.length || 0})</h3>
      {tree?.level2?.map(u => <div key={u.uid}>{u.name} ({u.username})</div>)}
    </div>
  );
}
```

## Step 8: Update Backend Deployment

### Vercel:
- Add `firebase-admin` to `package.json` dependencies ✅ (done)
- Add env vars (Step 4)

### Render:
- Add env vars in Render dashboard
- `npm install firebase-admin`

## Step 9: Test

1. Sign in with Google → new email → profile page
2. Enter name + username → referral code (optional) → complete
3. Sign out → sign in again → goes directly to site
4. Like/save videos → works
5. Dashboard → referral tree shows

## Troubleshooting

### "Firebase Admin not initialized" in backend logs
- `FIREBASE_PRIVATE_KEY` not set correctly
- Check `.env` file has the full key with `\n` escapes

### "Invalid token" on API calls
- Token expired — get new token with `getIdToken()`
- Make sure frontend sends `Authorization: Bearer <token>` header

### "Username already exists"
- Try a different username
- Usernames are unique across all users

### "Invalid referral code"
- Make sure the code starts with `REF-`
- Only existing users' codes work
