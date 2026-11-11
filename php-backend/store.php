<?php
// Intimora PHP Backend — Telegram Storage Layer
// NO MySQL data storage — all data stored in Telegram channels (like Node.js version)
// Videos → TG_CHANNEL_META (JSON text messages)
// Users → TG_CHANNEL_USERS (JSON text messages)

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/telegram.php';

// === In-Memory Cache ===
// 60-second cache — same as Node.js users.js
$_storeCache = [
    'videos' => ['data' => null, 'time' => 0],
    'users' => ['data' => null, 'time' => 0],
];

function store_cache($type, $data) {
    global $_storeCache;
    $_storeCache[$type]['data'] = $data;
    $_storeCache[$type]['time'] = time();
}

function store_get_cache($type) {
    global $_storeCache;
    if ($_storeCache[$type]['data'] !== null && (time() - $_storeCache[$type]['time']) < 60) {
        return $_storeCache[$type]['data'];
    }
    return null;
}

function store_clear_cache($type = null) {
    global $_storeCache;
    if ($type) {
        $_storeCache[$type]['data'] = null;
        $_storeCache[$type]['time'] = 0;
    } else {
        foreach (array_keys($_storeCache) as $key) {
            $_storeCache[$key]['data'] = null;
            $_storeCache[$key]['time'] = 0;
        }
    }
}

// === Telegram Storage ===

// Get all messages from a Telegram channel (via MTProto GetHistory)
function store_get_channel_messages($channel, $maxPages = 50) {
    $client = tg_connect();
    $inputEntity = tg_get_input_entity($channel);

    $allMessages = [];
    $offsetId = null;

    for ($page = 0; $page < $maxPages; $page++) {
        $request = new \danog\MadelineProto\TL\Api\messages\GetHistory([
            'peer' => $inputEntity,
            'limit' => 200,
            'offset_id' => $offsetId ? $offsetId : 0,
            'max_id' => 0,
            'min_id' => 0,
            'add_offset' => 0,
        ]);

        $result = $client->invoke($request);

        if (empty($result['messages'])) {
            break;
        }

        $messages = $result['messages'];
        $allMessages = array_merge($allMessages, $messages);

        $oldest = $messages[0];
        $offsetId = $oldest['id'];

        if (count($messages) < 200) break;
    }

    return $allMessages;
}

// Read all videos from Telegram meta channel
function store_get_videos() {
    $cached = store_get_cache('videos');
    if ($cached !== null) return $cached;

    $messages = store_get_channel_messages(TG_CHANNEL_META);
    $videos = [];

    foreach ($messages as $msg) {
        $text = $msg['message'] ?? '';
        if (empty($text)) continue;

        // Parse JSON — format: {"t":"meta","id":"...","title":"...","video":{...}}
        $data = json_decode($text, true);
        if (!$data || ($data['t'] ?? '') !== 'meta') continue;

        $videos[] = $data;
    }

    // Sort by createdAt descending (newest first)
    usort($videos, function($a, $b) {
        return ($b['createdAt'] ?? 0) - ($a['createdAt'] ?? 0);
    });

    store_cache('videos', $videos);
    return $videos;
}

// Get single video by ID
function store_get_video($videoId) {
    $videos = store_get_videos();
    foreach ($videos as $v) {
        if (($v['id'] ?? '') === $videoId) {
            return $v;
        }
    }
    return null;
}

// Add new video to Telegram meta channel
function store_add_video($videoData) {
    // Set timestamp
    if (!isset($videoData['createdAt'])) {
        $videoData['createdAt'] = time();
    }
    if (!isset($videoData['views'])) {
        $videoData['views'] = 0;
    }
    if (!isset($videoData['likes'])) {
        $videoData['likes'] = 0;
    }
    if (!isset($videoData['shares'])) {
        $videoData['shares'] = 0;
    }
    if (!isset($videoData['likedBy'])) {
        $videoData['likedBy'] = [];
    }
    if (!isset($videoData['savedBy'])) {
        $videoData['savedBy'] = [];
    }

    $json = json_encode($videoData, JSON_PRETTY_PRINT);

    // Send to Telegram meta channel
    $result = tg_send_message(TG_CHANNEL_META, $json);

    // Clear cache
    store_clear_cache('videos');

    return $result;
}

// Update video in Telegram
function store_update_video($videoId, $updates) {
    $videos = store_get_videos();
    $updated = false;

    foreach ($videos as $i => $v) {
        if (($v['id'] ?? '') === $videoId) {
            $videos[$i] = array_merge($v, $updates);
            $updated = true;
            break;
        }
    }

    if ($updated) {
        // Re-send updated video to Telegram
        store_add_video($videos[$i]);
    }

    return $updated;
}

// Delete video from Telegram
function store_delete_video($videoId) {
    $videos = store_get_videos();
    $video = null;

    foreach ($videos as $v) {
        if (($v['id'] ?? '') === $videoId) {
            $video = $v;
            break;
        }
    }

    if ($video) {
        // Note: MTProto can delete messages
        // This is a simplified version — actual deletion requires message ID tracking
        // For now, we just clear cache (video will still be in Telegram)
        store_clear_cache('videos');
    }

    return $video !== null;
}

// Read all users from Telegram users channel
function store_get_users() {
    $cached = store_get_cache('users');
    if ($cached !== null) return $cached;

    $messages = store_get_channel_messages(TG_CHANNEL_USERS);
    $users = [];

    foreach ($messages as $msg) {
        $text = $msg['message'] ?? '';
        if (empty($text)) continue;

        // Parse JSON — format: {"t":"user","id":"...","name":"..."}
        $data = json_decode($text, true);
        if (!$data || ($data['t'] ?? '') !== 'user') continue;

        $users[] = $data;
    }

    store_cache('users', $users);
    return $users;
}

// Get single user by ID
function store_get_user($userId) {
    $users = store_get_users();
    foreach ($users as $u) {
        if (($u['id'] ?? '') === $userId) {
            return $u;
        }
    }
    return null;
}

// Add new user to Telegram users channel
function store_add_user($userData) {
    if (!isset($userData['createdAt'])) {
        $userData['createdAt'] = time();
    }
    if (!isset($userData['likes'])) {
        $userData['likes'] = 0;
    }
    if (!isset($userData['saves'])) {
        $userData['saves'] = 0;
    }
    if (!isset($userData['referral_code'])) {
        $userData['referral_code'] = substr(md5($userData['id'] ?? ''), 0, 8);
    }

    $json = json_encode($userData, JSON_PRETTY_PRINT);
    $result = tg_send_message(TG_CHANNEL_USERS, $json);

    store_clear_cache('users');
    return $result;
}

// Update user in Telegram
function store_update_user($userId, $updates) {
    $users = store_get_users();
    $updated = false;

    foreach ($users as $i => $u) {
        if (($u['id'] ?? '') === $userId) {
            $users[$i] = array_merge($u, $updates);
            $updated = true;
            break;
        }
    }

    if ($updated) {
        store_add_user($users[$i]);
    }

    return $updated;
}

// Toggle like on video
function store_toggle_like($videoId, $userId) {
    $videos = store_get_videos();
    $video = null;

    foreach ($videos as $i => $v) {
        if (($v['id'] ?? '') === $videoId) {
            $video = $videos[$i];
            break;
        }
    }

    if (!$video) return null;

    $likedBy = $video['likedBy'] ?? [];
    $liked = in_array($userId, $likedBy);

    if ($liked) {
        // Un-like
        $likedBy = array_values(array_filter($likedBy, function($id) use ($userId) {
            return $id !== $userId;
        }));
        $video['likes'] = max(0, ($video['likes'] ?? 0) - 1);
    } else {
        // Like
        $likedBy[] = $userId;
        $video['likes'] = ($video['likes'] ?? 0) + 1;
    }

    $video['likedBy'] = $likedBy;
    store_add_video($video);

    return !$liked; // true = liked, false = un-liked
}

// Toggle save on video
function store_toggle_save($videoId, $userId) {
    $videos = store_get_videos();
    $video = null;

    foreach ($videos as $i => $v) {
        if (($v['id'] ?? '') === $videoId) {
            $video = $videos[$i];
            break;
        }
    }

    if (!$video) return null;

    $savedBy = $video['savedBy'] ?? [];
    $saved = in_array($userId, $savedBy);

    if ($saved) {
        // Un-save
        $savedBy = array_values(array_filter($savedBy, function($id) use ($userId) {
            return $id !== $userId;
        }));
    } else {
        // Save
        $savedBy[] = $userId;
    }

    $video['savedBy'] = $savedBy;
    store_add_video($video);

    return !$saved; // true = saved, false = un-saved
}

// Increment video views
function store_increment_views($videoId) {
    $videos = store_get_videos();

    foreach ($videos as $i => $v) {
        if (($v['id'] ?? '') === $videoId) {
            $videos[$i]['views'] = ($videos[$i]['views'] ?? 0) + 1;
            store_add_video($videos[$i]);
            break;
        }
    }
}

// Get video formatted (matches Node.js API response)
function store_format_video($video) {
    return [
        'id' => $video['id'],
        'title' => $video['title'],
        'description' => $video['description'] ?? '',
        'exclusive' => (bool)($video['exclusive'] ?? false),
        'views' => (int)($video['views'] ?? 0),
        'likes' => (int)($video['likes'] ?? 0),
        'shares' => (int)($video['shares'] ?? 0),
        'duration' => (int)($video['duration'] ?? 0),
        'createdAt' => (int)($video['createdAt'] ?? 0),
        'video' => [
            'tg_doc_id' => $video['video']['tg_doc_id'] ?? '',
            'tg_access_hash' => $video['video']['tg_access_hash'] ?? '',
            'tg_file_ref' => $video['video']['tg_file_ref'] ?? '',
            'tg_size' => (int)($video['video']['tg_size'] ?? 0),
            'tg_mime' => $video['video']['tg_mime'] ?? 'video/mp4',
            'tg_channel' => $video['video']['tg_channel'] ?? '',
            'tg_msg_id' => (int)($video['video']['tg_msg_id'] ?? 0),
            'tg_filename' => $video['video']['tg_filename'] ?? 'video.mp4',
        ],
        'thumbnail' => [
            'thumb_doc_id' => $video['thumbnail']['thumb_doc_id'] ?? '',
            'thumb_access_hash' => $video['thumbnail']['thumb_access_hash'] ?? '',
            'thumb_file_ref' => $video['thumbnail']['thumb_file_ref'] ?? '',
            'thumb_size' => (int)($video['thumbnail']['thumb_size'] ?? 0),
            'thumb_msg_id' => isset($video['thumbnail']['thumb_msg_id']) ? (int)$video['thumbnail']['thumb_msg_id'] : null,
        ],
        'is_fast_start' => (bool)($video['is_fast_start'] ?? false),
    ];
}

// Get user formatted (matches Node.js API response)
function store_format_user($user) {
    return [
        'id' => $user['id'],
        'name' => $user['name'] ?? '',
        'username' => $user['username'] ?? '',
        'referral_code' => $user['referral_code'] ?? '',
        'likes' => (int)($user['likes'] ?? 0),
        'saves' => (int)($user['saves'] ?? 0),
        'createdAt' => (int)($user['createdAt'] ?? 0),
    ];
}

// === Referrals ===

// Read all referrals from Telegram referrals channel
function store_get_referrals() {
    $cached = store_get_cache('referrals');
    if ($cached !== null) return $cached;

    $messages = store_get_channel_messages(TG_CHANNEL_REFERRALS);
    $referrals = [];

    foreach ($messages as $msg) {
        $text = $msg['message'] ?? '';
        if (empty($text)) continue;

        // Parse JSON — format: {"t":"referral","ownerCode":"...","referredCode":"...","referredUid":"..."}
        $data = json_decode($text, true);
        if (!$data || ($data['t'] ?? '') !== 'referral') continue;

        $referrals[] = $data;
    }

    store_cache('referrals', $referrals);
    return $referrals;
}

// Get referral tree for a user
function store_get_referral_tree($userId) {
    // Find user to get their referral code
    $user = store_get_user($userId);
    if (!$user) return null;

    $myCode = $user['referral_code'] ?? '';

    $allReferrals = store_get_referrals();

    // Direct referrals (used my code)
    $direct = array_filter($allReferrals, function($r) use ($myCode) {
        return ($r['ownerCode'] ?? '') === $myCode;
    });

    // Level 2: referrals of my referrals
    $directCodes = array_map(function($r) { return $r['referredCode'] ?? ''; }, $direct);
    $level2 = array_filter($allReferrals, function($r) use ($directCodes) {
        return in_array($r['ownerCode'] ?? '', $directCodes);
    });

    // Get user details for each referral
    $allUsers = store_get_users();
    $userMap = [];
    foreach ($allUsers as $u) {
        $code = $u['referral_code'] ?? '';
        if ($code) $userMap[$code] = $u;
    }

    // Format referral users with explicit fields (email, Firebase UID, liked/saved)
    $formatUser = function($u) {
        if (!$u) return null;
        return [
            'email' => $u['email'] ?? '',
            'firebaseUid' => $u['id'] ?? '',
            'name' => $u['name'] ?? '',
            'username' => $u['username'] ?? '',
            'avatar' => $u['avatar'] ?? '',
            'referralCode' => $u['referral_code'] ?? '',
            'likedVideos' => $u['likedVideos'] ?? [],
            'savedVideos' => $u['savedVideos'] ?? [],
            'createdAt' => (int)($u['createdAt'] ?? 0),
        ];
    };

    $directUsers = array_map(function($r) use ($userMap, $formatUser) {
        return $formatUser($userMap[$r['referredCode'] ?? ''] ?? null);
    }, array_values($direct));

    $level2Users = array_map(function($r) use ($userMap, $formatUser) {
        return $formatUser($userMap[$r['referredCode'] ?? ''] ?? null);
    }, array_values($level2));

    return [
        'code' => $myCode,
        'direct' => array_filter($directUsers),
        'level2' => array_filter($level2Users),
    ];
}

// Add referral record to Telegram
function store_add_referral($ownerCode, $referredCode, $referredUid) {
    $data = [
        't' => 'referral',
        'ownerCode' => $ownerCode,
        'referredCode' => $referredCode,
        'referredUid' => $referredUid,
        'createdAt' => time(),
    ];

    $json = json_encode($data, JSON_PRETTY_PRINT);
    tg_send_message(TG_CHANNEL_REFERRALS, $json);

    store_clear_cache('referrals');
    return $data;
}
