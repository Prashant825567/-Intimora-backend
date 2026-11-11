# Intimora PHP Backend

PHP version of the Intimora backend for **InfinityFree** hosting.
Same features as Node.js version, but PHP + MySQL.

## Features

- ✅ Video streaming with HTTP Range support (MTProto — direct from Telegram)
- ✅ **MTProto — No Bot API limits!** Unlimited file size, direct channel access
- ✅ Fast-start optimization (ftyp + moov atom handling)
- ✅ Firebase token verification
- ✅ User registration & profile
- ✅ Like / Save videos
- ✅ Admin upload / sync / delete
- ✅ MySQL data storage
- ✅ 60-second in-memory cache
- ✅ CORS support

## Setup on InfinityFree

### 1. Enable Composer
InfinityFree dashboard → **Terminal** → run:
```bash
composer require danog/madelineproto
```

### 2. Create MySQL Database
1. InfinityFree Dashboard → MySQL Databases
2. Create database `intimora`
3. Import `schema.sql`
4. Note: username, password, host

### 3. Edit config.php
Open `config.php` and update:
```php
define('DB_USER', 'YOUR_DB_USER');
define('DB_PASS', 'YOUR_DB_PASSWORD');
define('ADMIN_API_KEY', 'YOUR_ADMIN_KEY');
// TELEGRAM_SESSION is already set — same as Vercel
```

### 4. Upload to InfinityFree
**Method A: FTP**
1. Download FileZilla
2. FTP host: `intimora-api2.site.je`
3. Upload all files to `public_html/`

**Method B: File Manager**
1. InfinityFree Dashboard → File Manager → `public_html/`
2. Upload all files

### 5. Install MadelineProto
InfinityFree Terminal:
```bash
cd public_html/php-backend
composer install
```

### 6. Test
```
https://intimora-api2.site.je/api/health
```
Should return: `{"ok":true,"data":{"status":"ok"}}`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/videos` | List videos (page, limit) |
| GET | `/api/videos/:id` | Get video details |
| GET | `/api/videos/:id/stream` | Stream video (Range support) |
| GET | `/api/videos/:id/thumbnail` | Get thumbnail |
| POST | `/api/users/register` | Register/Login (Firebase token) |
| GET | `/api/users/me` | Get user profile |
| POST | `/api/users/like` | Toggle like |
| POST | `/api/users/save` | Toggle save |
| POST | `/api/admin/upload` | Upload video (admin) |
| POST | `/api/admin/sync` | Sync from Telegram (admin) |
| POST | `/api/admin/delete` | Delete video (admin) |
| GET | `/api/admin/export` | Export all videos (admin) |

## Admin Headers

For admin endpoints, send:
```
X-Admin-Key: YOUR_ADMIN_KEY
```

## Auth

For user endpoints, send Firebase ID token:
```
Authorization: Bearer <firebase_id_token>
```

## MTProto vs Bot API

| Feature | MTProto (PHP + MadelineProto) | Bot API |
|---------|------------------------------|---------|
| File size limit | ✅ None — direct streaming | ❌ 50 MB max |
| Channel access | ✅ Direct — GetHistory | ❌ Bot must be admin |
| Read messages | ✅ All channel messages | ❌ Only bot updates |
| Upload | ✅ Any size | ❌ 50 MB limit |
| Session | ✅ String session (same as Vercel) | ❌ Bot token only |
| Rate limits | ✅ Less restrictive | ❌ 30 msgs/sec |

## Limitations

- ❌ No ffmpeg on InfinityFree → fast-start optimization skipped (video still plays, just slower start)
- ⚠️ MadelineProto is async — requires PHP 8.1+ and amphp
- ⚠️ InfinityFree might need terminal access for Composer install
- ✅ Streaming works with Range requests via MTProto
- ✅ Sync reads all channel messages via GetHistory
- ✅ All other features work normally

## File Structure

```
php-backend/
├── .htaccess        # URL rewriting
├── composer.json    # MadelineProto dependency
├── config.php       # Configuration + session
├── db.php           # MySQL connection + helpers
├── mtproto.php      # MTProto client wrapper
├── telegram.php     # Telegram MTProto operations
├── index.php        # Main API router
├── schema.sql       # Database schema
├── cache/           # Cache directory (auto-created)
└── README.md        # This file
```
