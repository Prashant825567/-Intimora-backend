<?php
// Intimora PHP Backend — Configuration (ALL VALUES HARDCODED)
// Nothing to set — just upload and go!

// === Telegram MTProto ===
define('TG_API_ID', '37144075');
define('TG_API_HASH', '57a11adf8679a2e7a2b6184ed7bb9c70');
define('TELEGRAM_SESSION', '1BQANOTEuMTA4LjU2LjE2OAG7vgReHhhtqlojOVMRi3XnyHG7Q7KoYTwTUic7gFcu8Rz5Un+EFSLyqho/lrNN7gm9xzxM8SaRhFL1kNJX2OvpCAEGNLlNQGQiONPBNlh9w0XKxed9GBK5udJjvh3ssyP0ZuY9WOQ/J9W3I6R4yQZ20XOi13n+KT4DXSjmM/eMYZJoez+hD1cG5eVt5GUzdviSrbnDFPQnDCc0RNCsdNaajYUqZd9OPlH3/psn/Ypju+ylGJRito/TABHwM+/nz7j/5pPyOF6uQ+cuNQx3zfTHF+uVYQFHIqVBBHwK6HF/ui6zCiXC7rqUkjGGC5urbKhJIIsRO9I+9RMIuameuOdDfg==');

// === Telegram Channels ===
define('TG_CHANNEL_VIDEO', '-1003756299546');
define('TG_CHANNEL_THUMB', '-1004360811639');
define('TG_CHANNEL_META', '-1003777974779');
define('TG_CHANNEL_USERS', '-1004368963146');
define('TG_CHANNEL_REFERRALS', '-1004451213988');

// === MySQL (EDIT THESE 2 VALUES ONLY) ===
// Get from: InfinityFree Dashboard → MySQL Databases
define('DB_HOST', 'localhost');
define('DB_NAME', 'intimora');
define('DB_USER', 'if0_43413402');
define('DB_PASS', 'jGuhBV4XZ5');

// === Firebase ===
define('FIREBASE_API_KEY', 'AIzaSyD91f9kLylYXZnZjPSZOfjk1HFJ0Y-v7Yo');
define('FIREBASE_AUTH_DOMAIN', 'intimora-app.firebaseapp.com');

// === Admin ===
define('ADMIN_API_KEY', 'Prashant');

// === Site ===
define('SITE_URL', 'https://intimora-api2.site.je');

// === Cache ===
$cacheDir = __DIR__ . '/cache';
if (!is_dir($cacheDir)) {
    mkdir($cacheDir, 0755, true);
}

// === FFmpeg (InfinityFree does NOT have ffmpeg — will be skipped) ===
define('FFMPEG_PATH', '/usr/bin/ffmpeg');
define('FFPROBE_PATH', '/usr/bin/ffprobe');
