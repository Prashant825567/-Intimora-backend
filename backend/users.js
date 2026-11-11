// User management — all data stored in Telegram channels
// Users channel: JSON text messages with user data
// Referrals channel: JSON text messages with referral links

const tg = require("./telegram");

// ---- User JSON format ----
// {
//   t: "user",
//   email: "user@gmail.com",
//   name: "John Doe",
//   username: "johndoe",
//   uid: "firebase-uid",
//   referralCode: "REF-ABC123",
//   referredBy: "REF-XYZ789",
//   likedVideos: ["vid-1", "vid-2"],
//   savedVideos: ["vid-3"],
//   avatar: "https://...",
//   createdAt: 1234567890
// }

// ---- Referral JSON format ----
// {
//   t: "ref",
//   ownerCode: "REF-AAA",
//   referredCode: "REF-BBB",
//   timestamp: 1234567890
// }

// ---- Generate referral code ----
function generateReferralCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return "REF-" + code;
}

// ---- In-memory cache for users ----
let usersCache = null;
let usersCacheTime = 0;
const CACHE_TTL = 60000; // 60 seconds

async function readUsers() {
  // Check cache first
  if (usersCache && (Date.now() - usersCacheTime) < CACHE_TTL) {
    return usersCache;
  }

  const messages = await tg.readMessages(tg.channelUsers(), 5000);
  usersCache = messages
    .map((m) => {
      try {
        const user = JSON.parse(m.text);
        user._msgId = m.id;
        return user;
      } catch { return null; }
    })
    .filter((u) => u && u.t === "user");
  usersCacheTime = Date.now();
  return usersCache;
}

function invalidateCache() {
  usersCache = null;
  usersCacheTime = 0;
}

// ---- Read all referrals from Telegram ----
async function readReferrals() {
  const messages = await tg.readMessages(tg.channelReferrals(), 5000);
  return messages
    .map((m) => {
      try { return JSON.parse(m.text); } catch { return null; }
    })
    .filter((r) => r && r.t === "ref");
}

// ---- Find user by email ----
async function findByEmail(email) {
  const users = await readUsers();
  return users.find((u) => u.email === email);
}

// ---- Find user by uid ----
async function findByUid(uid) {
  const users = await readUsers();
  return users.find((u) => u.uid === uid);
}

// ---- Find user by username ----
async function findByUsername(username) {
  const users = await readUsers();
  return users.find((u) => u.username === username);
}

// ---- Find user by referral code ----
async function findByReferralCode(code) {
  const users = await readUsers();
  return users.find((u) => u.referralCode === code);
}

// ---- Create new user ----
async function createUser({ email, name, username, uid, avatar, referredBy }) {
  const user = {
    t: "user",
    email,
    name,
    username,
    uid,
    referralCode: generateReferralCode(),
    referredBy: referredBy || "",
    likedVideos: [],
    savedVideos: [],
    avatar: avatar || "",
    createdAt: Math.floor(Date.now() / 1000),
  };

  // Save user to Telegram Users channel
  await tg.sendMessage(tg.channelUsers(), JSON.stringify(user));

  // Save referral link if referredBy is set
  if (referredBy) {
    const ref = {
      t: "ref",
      ownerCode: referredBy,
      referredCode: user.referralCode,
      timestamp: Math.floor(Date.now() / 1000),
    };
    await tg.sendMessage(tg.channelReferrals(), JSON.stringify(ref));
  }

  invalidateCache();
  return user;
}

// ---- Update user ----
async function updateUser(uid, updates) {
  const user = await findByUid(uid);
  if (!user) return null;
  Object.assign(user, updates);
  await tg.editMessage(tg.channelUsers(), user._msgId, JSON.stringify(user));
  invalidateCache();
  return user;
}

// ---- Toggle like on video ----
async function toggleLike(uid, videoId) {
  const user = await findByUid(uid);
  if (!user) return null;
  const liked = user.likedVideos || [];
  const idx = liked.indexOf(videoId);
  if (idx >= 0) {
    liked.splice(idx, 1);
  } else {
    liked.push(videoId);
  }
  user.likedVideos = liked;
  await tg.editMessage(tg.channelUsers(), user._msgId, JSON.stringify(user));

  // Update cache timestamp — user object is from cache, already modified
  usersCacheTime = Date.now();
  return { liked: idx === -1, likedVideos: liked };
}

// ---- Toggle save on video ----
async function toggleSave(uid, videoId) {
  const user = await findByUid(uid);
  if (!user) return null;
  const saved = user.savedVideos || [];
  const idx = saved.indexOf(videoId);
  if (idx >= 0) {
    saved.splice(idx, 1);
  } else {
    saved.push(videoId);
  }
  user.savedVideos = saved;
  await tg.editMessage(tg.channelUsers(), user._msgId, JSON.stringify(user));

  // Update cache timestamp — user object is from cache, already modified
  usersCacheTime = Date.now();
  return { saved: idx === -1, savedVideos: saved };
}

// ---- Get referral tree ----
async function getReferralTree(uid) {
  const user = await findByUid(uid);
  if (!user) return null;

  const allReferrals = await readReferrals();
  const myCode = user.referralCode;

  // Direct referrals (used my code)
  const direct = allReferrals.filter((r) => r.ownerCode === myCode);

  // Level 2: referrals of my referrals
  const directCodes = direct.map((r) => r.referredCode);
  const level2 = allReferrals.filter((r) => directCodes.includes(r.ownerCode));

  // Get user details for each referral
  const users = await readUsers();
  const userMap = {};
  users.forEach((u) => { userMap[u.referralCode] = u; });

  // Format referral users with explicit fields
  const formatUser = (u) => ({
    email: u.email || '',
    firebaseUid: u.uid || '',
    name: u.name || '',
    username: u.username || '',
    avatar: u.avatar || '',
    referralCode: u.referralCode || '',
    likedVideos: u.likedVideos || [],
    savedVideos: u.savedVideos || [],
    createdAt: u.createdAt || 0,
  });

  return {
    code: myCode,
    direct: direct.map((r) => formatUser(userMap[r.referredCode])).filter(Boolean),
    level2: level2.map((r) => formatUser(userMap[r.referredCode])).filter(Boolean),
  };
}

// ---- Get user's liked videos ----
async function getLikedVideos(uid) {
  const user = await findByUid(uid);
  if (!user) return null;
  return user.likedVideos || [];
}

// ---- Get user's saved videos ----
async function getSavedVideos(uid) {
  const user = await findByUid(uid);
  if (!user) return null;
  return user.savedVideos || [];
}

module.exports = {
  generateReferralCode,
  readUsers,
  readReferrals,
  findByEmail,
  findByUid,
  findByUsername,
  findByReferralCode,
  createUser,
  updateUser,
  toggleLike,
  toggleSave,
  getReferralTree,
  getLikedVideos,
  getSavedVideos,
};
