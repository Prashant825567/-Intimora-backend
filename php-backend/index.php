<?php
// Intimora PHP Backend — Main API Router
// Works on InfinityFree (PHP 8.4, MySQL 8.0)

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/store.php';
require_once __DIR__ . '/telegram.php';

// === CORS ===
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, Range, If-Range');
header('Access-Control-Expose-Headers: Accept-Ranges, Content-Range, Content-Length, Content-Type');
header('Access-Control-Max-Age: 86400');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// === Helper ===
function json_ok($data = []) {
    header('Content-Type: application/json');
    echo json_encode(['ok' => true, 'data' => $data]);
}

function json_fail($error, $code = 400) {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'error' => $error]);
}

function get_bearer_token() {
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/Bearer\s+(.*)$/i', $auth, $m)) {
        return $m[1];
    }
    return null;
}

function verify_firebase_token($token) {
    if (!$token) return null;
    $url = 'https://www.googleapis.com/identitytoolkit/v3/verify_token?key=' . FIREBASE_API_KEY;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POSTFIELDS => json_encode(['idToken' => $token]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_TIMEOUT => 10,
    ]);
    $resp = curl_exec($ch);
    curl_close($ch);
    $data = json_decode($resp, true);
    if (isset($data['verified']) && $data['verified']) {
        return $data['payload'] ?? null;
    }
    return null;
}

function get_user_from_token($token) {
    $payload = verify_firebase_token($token);
    if (!$payload) return null;
    $uid = $payload['sub'] ?? null;
    if (!$uid) return null;
    // Check if user exists in Telegram storage
    $user = store_get_user($uid);
    if (!$user) {
        // Auto-create user in Telegram
        store_add_user([
            'id' => $uid,
            'name' => $payload['name'] ?? '',
            'username' => $payload['email'] ?? '',
            'referral_code' => substr(md5($uid), 0, 8),
        ]);
        $user = store_get_user($uid);
    }
    return $user;
}

// === Route ===
$uri = $_SERVER['REQUEST_URI'];
$method = $_SERVER['REQUEST_METHOD'];

// Parse path
$path = parse_url($uri, PHP_URL_PATH);
$parts = explode('/', trim($path, '/'));

// Remove 'api' prefix
if ($parts[0] === 'api') {
    array_shift($parts);
}

$route = $parts[0] ?? '';
$id = $parts[1] ?? '';
$action = $parts[2] ?? '';

// ============================
// ROUTES
// ============================

// Health check
if ($route === 'health' && $method === 'GET') {
    json_ok(['status' => 'ok', 'time' => time()]);
    exit;
}

// === Videos ===

// List videos
if ($route === 'videos' && $method === 'GET') {
    $page = max(1, (int)($_GET['page'] ?? 1));
    $limit = min(50, max(1, (int)($_GET['limit'] ?? 20)));
    $offset = ($page - 1) * $limit;

    $allVideos = store_get_videos();
    $total = count($allVideos);
    $videos = array_slice($allVideos, $offset, $limit);

    $formatted = array_map('store_format_video', $videos);

    json_ok([
        'videos' => $formatted,
        'page' => $page,
        'total' => $total,
        'totalPages' => ceil($total / $limit),
    ]);
    exit;
}

// Get single video
if ($route === 'videos' && $id && $method === 'GET') {
    $video = store_get_video($id);
    if (!$video) {
        json_fail('Video not found', 404);
        exit;
    }
    // Increment views
    store_increment_views($id);
    $video['views'] = (int)($video['views'] ?? 0) + 1;

    json_ok(store_format_video($video));
    exit;
}

// Stream video (MTProto — direct from Telegram)
if ($route === 'videos' && $id && $action === 'stream' && $method === 'GET') {
    $video = store_get_video($id);
    if (!$video) {
        json_fail('Video not found', 404);
        exit;
    }

    $fileSize = (int)($video['video']['tg_size'] ?? 0);
    $videoMeta = [
        'tg_doc_id' => $video['video']['tg_doc_id'] ?? '',
        'tg_access_hash' => $video['video']['tg_access_hash'] ?? '',
        'tg_file_ref' => $video['video']['tg_file_ref'] ?? '',
        'tg_size' => $fileSize,
        'tg_mime' => $video['video']['tg_mime'] ?? 'video/mp4',
    ];

    // Parse Range header
    $start = 0;
    $end = $fileSize - 1;
    $status = 200;

    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if ($range) {
        if (preg_match('/bytes=(\d*)-(\d*)/', $range, $m)) {
            if ($m[1] !== '') {
                $start = (int)$m[1];
                $end = $m[2] !== '' ? (int)$m[2] : $fileSize - 1;
            } elseif ($m[2] !== '') {
                $suffix = (int)$m[2];
                $start = max(0, $fileSize - $suffix);
                $end = $fileSize - 1;
            }
            $end = min($end, $fileSize - 1);
            $status = 206;
        }
    }

    if ($start >= $fileSize || $start > $end) {
        header('Content-Range: bytes */' . $fileSize);
        header('Accept-Ranges: bytes');
        http_response_code(416);
        exit;
    }

    // ---- Fast-start optimization ----
    // If browser requests from offset 0 and moov is at END,
    // send ftyp + moov first so browser can start playing immediately
    if ($start === 0) {
        try {
            $moov = tg_find_moov_atom($videoMeta);
            if ($moov) {
                // moov is at the end — send ftyp + moov as 206 response
                $ftypData = tg_read_file_range($videoMeta, 0, 31);
                $totalBytes = strlen($ftypData) + strlen($moov['data']);

                http_response_code(206);
                header('Content-Type: video/mp4');
                header('Accept-Ranges: bytes');
                header('Content-Length: ' . $totalBytes);
                header('Content-Range: bytes 0-' . ($totalBytes - 1) . '/' . $fileSize);
                header('Cache-Control: public, max-age=3600');
                header('Vary: Origin, Range');
                header('Cross-Origin-Resource-Policy: cross-origin');

                echo $ftypData;
                echo $moov['data'];
                exit;
            }
        } catch (Exception $e) {
            // moov search failed — normal streaming
        }
    }

    // Normal streaming via MTProto
    http_response_code($status);
    header('Content-Type: ' . ($video['tg_mime'] ?? 'video/mp4'));
    header('Accept-Ranges: bytes');
    header('Content-Disposition: inline');
    header('Cache-Control: public, max-age=3600');
    header('Vary: Origin, Range');
    header('Cross-Origin-Resource-Policy: cross-origin');
    if ($status === 206) {
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $fileSize);
    }

    // Stream chunks from Telegram via MTProto
    foreach (tg_stream_range($videoMeta, $start, $end) as $chunk) {
        echo $chunk;
        flush();
    }
    exit;
}

// Get thumbnail (MTProto — direct from Telegram)
if ($route === 'videos' && $id && $action === 'thumbnail' && $method === 'GET') {
    $video = store_get_video($id);
    if (!$video || !$video['thumbnail']['thumb_doc_id']) {
        json_fail('No thumbnail available', 404);
        exit;
    }

    $thumbMeta = [
        'tg_doc_id' => $video['thumbnail']['thumb_doc_id'],
        'tg_access_hash' => $video['thumbnail']['thumb_access_hash'],
        'tg_file_ref' => $video['thumbnail']['thumb_file_ref'],
        'tg_size' => (int)($video['thumbnail']['thumb_size'] ?? 0),
    ];

    header('Content-Type: image/jpeg');
    header('Cache-Control: public, max-age=86400');
    header('Cross-Origin-Resource-Policy: cross-origin');

    // Download thumbnail via MTProto
    $thumbData = tg_read_file_range($thumbMeta, 0, (int)($video['thumbnail']['thumb_size'] ?? 100000));
    echo $thumbData;
    exit;
}

// === Users ===

// Register/Login (Firebase token)
if ($route === 'users' && $action === 'register' && $method === 'POST') {
    $token = get_bearer_token();
    if (!$token) {
        json_fail('No token provided', 401);
        exit;
    }

    $user = get_user_from_token($token);
    if (!$user) {
        json_fail('Invalid token', 401);
        exit;
    }

    json_ok([
        'id' => $user['id'],
        'name' => $user['name'],
        'username' => $user['username'],
        'referral_code' => $user['referral_code'],
        'likes' => (int)$user['likes'],
        'saves' => (int)$user['saves'],
    ]);
    exit;
}

// Get user profile
if ($route === 'users' && $action === 'me' && $method === 'GET') {
    $token = get_bearer_token();
    if (!$token) {
        json_fail('No token provided', 401);
        exit;
    }

    $user = get_user_from_token($token);
    if (!$user) {
        json_fail('Invalid token', 401);
        exit;
    }

    json_ok([
        'id' => $user['id'],
        'name' => $user['name'],
        'username' => $user['username'],
        'referral_code' => $user['referral_code'],
        'likes' => (int)$user['likes'],
        'saves' => (int)$user['saves'],
        'createdAt' => (int)$user['created_at'],
    ]);
    exit;
}

// Toggle like
if ($route === 'users' && $action === 'like' && $method === 'POST') {
    $token = get_bearer_token();
    $user = get_user_from_token($token);
    if (!$user) json_fail('Invalid token', 401);

    $input = json_decode(file_get_contents('php://input'), true);
    $videoId = $input['videoId'] ?? '';

    $liked = store_toggle_like($videoId, $user['id']);
    if ($liked === null) json_fail('Video not found', 404);

    json_ok(['liked' => $liked]);
    exit;
}

// Toggle save
if ($route === 'users' && $action === 'save' && $method === 'POST') {
    $token = get_bearer_token();
    $user = get_user_from_token($token);
    if (!$user) json_fail('Invalid token', 401);

    $input = json_decode(file_get_contents('php://input'), true);
    $videoId = $input['videoId'] ?? '';

    $saved = store_toggle_save($videoId, $user['id']);
    if ($saved === null) json_fail('Video not found', 404);

    json_ok(['saved' => $saved]);
    exit;
}

// Get referral tree (includes email, Firebase UID, liked/saved history of referred users)
if ($route === 'users' && $action === 'referrals' && $method === 'GET') {
    $token = get_bearer_token();
    $user = get_user_from_token($token);
    if (!$user) json_fail('Invalid token', 401);

    $tree = store_get_referral_tree($user['id']);
    if ($tree === null) json_fail('User not found', 404);

    json_ok($tree);
    exit;
}

// === Admin ===

// Verify admin
function verify_admin() {
    $adminKey = $_SERVER['HTTP_X_ADMIN_KEY'] ?? ($_GET['admin_key'] ?? '');
    if ($adminKey !== ADMIN_API_KEY) {
        json_fail('Admin key required', 403);
        exit;
    }
}

// Upload video (admin)
if ($route === 'admin' && $action === 'upload' && $method === 'POST') {
    verify_admin();

    if (empty($_FILES['video'])) {
        json_fail('No video file provided', 400);
        exit;
    }

    $file = $_FILES['video'];
    $title = $_POST['title'] ?? 'Untitled';
    $description = $_POST['description'] ?? '';
    $exclusive = isset($_POST['exclusive']) && $_POST['exclusive'] === 'true';

    // Process video for fast-start
    $tempFile = $file['tmp_name'];
    $processedFile = $tempFile . '.faststart.mp4';
    $moov = find_moov_atom($tempFile);
    if ($moov === null) {
        // moov at end — process for fast-start
        if (function_exists('shell_exec') && defined('FFMPEG_PATH')) {
            process_fast_start($tempFile, $processedFile);
        }
    }

    $uploadFile = file_exists($processedFile) ? $processedFile : $tempFile;
    $fileName = $file['name'];

    // Upload to Telegram
    $result = tg_upload_video(TG_CHANNEL_VIDEO, $uploadFile, $title, $fileName);
    if (!$result['ok']) {
        json_fail('Upload to Telegram failed: ' . ($result['error'] ?? 'unknown'), 500);
        exit;
    }

    $msg = $result['result'];
    $videoId = 'vid-' . time();

    // Save video metadata to Telegram meta channel (NO MySQL)
    store_add_video([
        't' => 'meta',
        'id' => $videoId,
        'title' => $title,
        'description' => $description,
        'exclusive' => $exclusive,
        'views' => 0,
        'likes' => 0,
        'shares' => 0,
        'duration' => 0,
        'createdAt' => time(),
        'likedBy' => [],
        'savedBy' => [],
        'video' => [
            'tg_doc_id' => $msg['document']['file_id'],
            'tg_access_hash' => $msg['document']['file_unique_id'],
            'tg_file_ref' => '',
            'tg_size' => $msg['document']['file_size'],
            'tg_mime' => $msg['document']['mime_type'],
            'tg_channel' => TG_CHANNEL_VIDEO,
            'tg_msg_id' => $msg['message_id'],
            'tg_filename' => $fileName,
        ],
        'thumbnail' => [
            'thumb_doc_id' => '',
            'thumb_access_hash' => '',
            'thumb_file_ref' => '',
            'thumb_size' => 0,
            'thumb_msg_id' => null,
        ],
        'is_fast_start' => file_exists($processedFile) ? 1 : 0,
    ]);

    // Cleanup temp files
    if (file_exists($tempFile)) unlink($tempFile);
    if (file_exists($processedFile)) unlink($processedFile);

    json_ok(['id' => $videoId, 'title' => $title]);
    exit;
}

// Sync from Telegram (admin) — MTProto GetHistory with pagination
if ($route === 'admin' && $action === 'sync' && $method === 'POST') {
    verify_admin();

    // Connect to Telegram via MTProto
    $client = tg_connect();
    $inputEntity = tg_get_input_entity(TG_CHANNEL_VIDEO);

    // Paginate through all messages (max 50 pages, 200 per page)
    $added = 0;
    $totalFetched = 0;
    $offsetId = null;

    for ($page = 0; $page < 50; $page++) {
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
        $totalFetched += count($messages);

        foreach ($messages as $msg) {
            $doc = $msg['document'] ?? null;
            if (!$doc) continue;
            if (!str_starts_with($doc['mime_type'] ?? '', 'video/')) continue;

            $msgId = (int)$msg['id'];
            $videoId = 'vid-' . $msgId;

            // Check if already exists (in Telegram storage)
            $existing = store_get_video($videoId);
            if ($existing) continue;

            // Save to Telegram meta channel (NO MySQL)
            store_add_video([
                't' => 'meta',
                'id' => $videoId,
                'title' => $msg['message'] ?? $msg['caption'] ?? $doc['file_name'] ?? 'Untitled',
                'description' => '',
                'exclusive' => false,
                'views' => 0,
                'likes' => 0,
                'shares' => 0,
                'duration' => 0,
                'createdAt' => time(),
                'likedBy' => [],
                'savedBy' => [],
                'video' => [
                    'tg_doc_id' => (string)$doc['id'],
                    'tg_access_hash' => (string)$doc['access_hash'],
                    'tg_file_ref' => base64_encode($doc['file_reference'] ?? ''),
                    'tg_size' => $doc['size'],
                    'tg_mime' => $doc['mime_type'],
                    'tg_channel' => TG_CHANNEL_VIDEO,
                    'tg_msg_id' => $msgId,
                    'tg_filename' => $doc['file_name'] ?? 'video.mp4',
                ],
                'thumbnail' => [
                    'thumb_doc_id' => '',
                    'thumb_access_hash' => '',
                    'thumb_file_ref' => '',
                    'thumb_size' => 0,
                    'thumb_msg_id' => null,
                ],
                'is_fast_start' => false,
            ]);

            $added++;
        }

        // Set offsetId to oldest message for next page
        $oldest = $messages[0];
        $offsetId = $oldest['id'];

        if (count($messages) < 200) break;
    }

    store_clear_cache('videos');
    json_ok(['added' => $added, 'total' => $totalFetched]);
    exit;
}

// Delete video (admin)
if ($route === 'admin' && $action === 'delete' && $method === 'POST') {
    verify_admin();

    $input = json_decode(file_get_contents('php://input'), true);
    $videoId = $input['id'] ?? '';

    // Delete from Telegram storage (NO MySQL)
    store_delete_video($videoId);
    store_clear_cache('videos');

    json_ok(['deleted' => true]);
    exit;
}

// Export all videos (admin)
if ($route === 'admin' && $action === 'export' && $method === 'GET') {
    verify_admin();
    $videos = store_get_videos();
    json_ok($videos);
    exit;
}

// 404
json_fail('Not found', 404);
