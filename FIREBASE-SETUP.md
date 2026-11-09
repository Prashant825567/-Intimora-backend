# Firebase Setup Guide — No Service Account Key Needed

## Approach: Firebase Auth REST API
- Sirf **API Key** needed — private key nahi
- `identitytoolkit.googleapis.com` se token verify hota hai
- Organization policy me service account key ban rahi hai toh koi problem nahi

---

## Step 1: Get Firebase API Key

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select project **intimora-app**
3. Click **Project Settings** (gear icon ⚙️)
4. Click **General** tab
5. **Your apps** section me web app ke liye:
   - `API key` dikhega — yehi hai `FIREBASE_API_KEY`

---

## Step 2: Update Backend `.env`

```
# Firebase (backend — token verification via REST API)
FIREBASE_API_KEY=AIzaSyD91f9kLylYXZnZjPSZOfjk1HFJ0Y-v7Yo
```

**Yehi hai — koi private key, client email nahi chahiye!**

---

## Step 3: Update Vercel/Render Environment Variables

### Vercel:
Go to Vercel → Project Settings → Environment Variables → Add:

| Variable | Value |
|----------|-------|
| `FIREBASE_API_KEY` | `AIzaSyD91f9kLylYXZnZjPSZOfjk1HFJ0Y-v7Yo` |

### Render:
Same — Environment Variables me add karo.

---

## Step 4: Install Dependencies

**Koi extra install nahi karna!** Firebase Admin SDK nahi chahiye.

Backend sirf `fetch` use karega — Node 20+ me built-in hai.

---

## Step 5: Frontend Setup

1. `firebase-auth.js` copy karo frontend project me
2. Import karo:

```javascript
import { signInWithGoogle, completeProfile, toggleLike, toggleSave, getReferralTree } from './firebase-auth';
```

---

## Step 6: Frontend Pages

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

---

## Step 7: Test Flow

1. **Sign in with Google** → new email → profile page
2. **Enter name + username** → referral code (optional) → complete
3. **Sign out** → sign in again → goes directly to site
4. **Like/save** videos → works
5. **Dashboard** → referral tree shows

---

## How Token Verification Works

### Frontend:
```javascript
// Firebase Auth (client-side)
const result = await signInWithPopup(auth, new GoogleAuthProvider());
const token = await result.user.getIdToken();
// Token sent to backend
```

### Backend:
```javascript
// REST API call — no private key needed
POST https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=API_KEY
{
  "idToken": "token_from_frontend",
  "maxResults": 1
}

// Response:
{
  "users": [{
    "localId": "firebase-uid",
    "email": "user@gmail.com"
  }]
}
```

---

## Troubleshooting

### "Invalid token" on API calls
- Token expired — get new token with `getIdToken()`
- Frontend `Authorization: Bearer <token>` header send karo

### "Username already exists"
- Try different username
- Usernames unique hain sabhi users ke liye

### "Invalid referral code"
- Code `REF-` prefix hona chahiye
- Sirf existing users ke codes work karte hain

### "FIREBASE_API_KEY not set"
- `.env` me `FIREBASE_API_KEY` add karo
- Vercel env vars me bhi add karo
