<?php
// Intimora PHP Backend — Telegram MTProto (MadelineProto)
// Full MTProto support — same as Node.js teleproto
// No Bot API limits — direct channel access, unlimited file size

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/mtproto.php';

// === MTProto Client Management ===

$_tgClient = null;

function tg() {
    global $_tgClient;
    if ($_tgClient === null) {
        $_tgClient = new MTProtoClient(TG_API_ID, TG_API_HASH, TELEGRAM_SESSION);
    }
    return $_tgClient;
}

function tg_connect() {
    $client = tg();
    if (!$client->isConnected()) {
        $client->connect();
    }
    return $client;
}

function tg_is_connected() {
    $client = tg();
    return $client && $client->isConnected();
}

// === Channel Operations ===

// Get input entity for channel
function tg_get_input_entity($channel) {
    $client = tg_connect();
    return $client->getInputEntity($channel);
}

// Get history from channel (GetHistory with pagination)
function tg_get_history($channel, $limit = 200, $offsetId = null) {
    $client = tg_connect();
    $inputEntity = tg_get_input_entity($channel);

    $request = new \danog\MadelineProto\TL\Api\messages\GetHistory([
        'peer' => $inputEntity,
        'limit' => $limit,
        'offset_id' => $offsetId ? $offsetId : 0,
        'max_id' => 0,
        'min_id' => 0,
        'add_offset' => 0,
    ]);

    return $client->invoke($request);
}

// Get messages by ID (using GetHistory with maxId)
function tg_get_messages($channel, $ids) {
    $client = tg_connect();
    $inputEntity = tg_get_input_entity($channel);
    $maxId = max($ids);

    $request = new \danog\MadelineProto\TL\Api\messages\GetHistory([
        'peer' => $inputEntity,
        'limit' => 1,
        'offset_id' => 0,
        'max_id' => $maxId,
        'min_id' => 0,
        'add_offset' => 0,
    ]);

    $result = $client->invoke($request);
    return $result['messages'] ?? [];
}

// === File Operations ===

// Get file for streaming (GetFile with offset/limit)
function tg_get_file($videoMeta, $offset, $limit) {
    $client = tg_connect();

    $location = new \danog\MadelineProto\TL\Api\upload\InputFileLocation([
        'id' => $videoMeta['tg_doc_id'],
        'access_hash' => $videoMeta['tg_access_hash'],
        'file_reference' => $videoMeta['tg_file_ref'] ?? '',
        'thumbnail' => null,
    ]);

    $request = new \danog\MadelineProto\TL\Api\upload\GetFile([
        'location' => $location,
        'offset' => $offset,
        'limit' => $limit,
    ]);

    return $client->invoke($request);
}

// Read file range (for streaming — 512KB parts)
function tg_read_file_range($videoMeta, $start, $end) {
    $client = tg_connect();
    $chunkSize = 512 * 1024; // 512KB — Telegram minimum

    $data = '';
    $currentOffset = $start;

    while ($currentOffset <= $end) {
        $limit = min($chunkSize, $end - $currentOffset + 1);
        $result = tg_get_file($videoMeta, $currentOffset, $limit);

        if (!$result || empty($result['data'])) {
            break;
        }

        $data .= $result['data'];
        $currentOffset += $limit;
    }

    return $data;
}

// Download media to file
function tg_download_media($msg, $outputFile) {
    $client = tg_connect();
    return $client->downloadMedia($msg, ['outputFile' => $outputFile]);
}

// Find moov atom in MP4 file
function tg_find_moov_atom($videoMeta) {
    $client = tg_connect();

    // Download first 2MB to check moov position
    $tempFile = tempnam(sys_get_temp_dir(), 'moov_check_');
    $tempHandle = fopen($tempFile, 'wb');

    // Read first 1MB
    $firstChunk = tg_read_file_range($videoMeta, 0, 1048576);
    fwrite($tempHandle, $firstChunk);
    fclose($tempHandle);

    // Check if moov is in first 1MB
    $fh = fopen($tempFile, 'rb');
    $header = fread($fh, 32);
    if (strpos($header, 'ftyp') !== false) {
        fseek($fh, 32, SEEK_SET);
        $offset = 32;

        while (!feof($fh)) {
            fseek($fh, $offset);
            $sizeBytes = fread($fh, 4);
            $typeBytes = fread($fh, 4);

            if (strlen($sizeBytes) < 4 || strlen($typeBytes) < 4) break;

            $size = unpack('N', $sizeBytes)[1];
            $type = $typeBytes;

            if ($type === 'moov') {
                fseek($fh, $offset);
                $data = fread($fh, $size);
                fclose($fh);
                unlink($tempFile);
                return ['start' => $offset, 'size' => $size, 'data' => $data];
            }

            if ($size <= 0) break;
            $offset += $size;
        }
    }

    fclose($fh);
    unlink($tempFile);

    // moov not in first 1MB — it's at the end
    // Download moov from end of file
    $fileSize = $videoMeta['tg_size'];
    $moovStart = max(0, $fileSize - 2097152); // Last 2MB

    // Read last 2MB to find moov
    $endChunk = tg_read_file_range($videoMeta, $moovStart, $fileSize - 1);
    $tempHandle2 = fopen($tempFile, 'wb');
    fwrite($tempHandle2, $endChunk);
    fclose($tempHandle2);

    $fh2 = fopen($tempFile, 'rb');
    $offset2 = 0;

    while (!feof($fh2)) {
        fseek($fh2, $offset2);
        $sizeBytes = fread($fh2, 4);
        $typeBytes = fread($fh2, 4);

        if (strlen($sizeBytes) < 4 || strlen($typeBytes) < 4) break;

        $size = unpack('N', $sizeBytes)[1];
        $type = $typeBytes;

        if ($type === 'moov') {
            $absoluteStart = $moovStart + $offset2;
            fseek($fh2, $offset2);
            $data = fread($fh2, $size);
            fclose($fh2);
            unlink($tempFile);
            return ['start' => $absoluteStart, 'size' => $size, 'data' => $data];
        }

        if ($size <= 0) break;
        $offset2 += $size;
    }

    fclose($fh2);
    unlink($tempFile);

    return null; // moov not found
}

// Stream file range (for HTTP streaming)
function tg_stream_range($videoMeta, $start, $end) {
    $client = tg_connect();
    $chunkSize = 512 * 1024; // 512KB parts

    $currentOffset = $start;

    // Generator-like yield using PHP generators
    $offset = $start;
    while ($offset <= $end) {
        $limit = min($chunkSize, $end - $offset + 1);

        $location = new \danog\MadelineProto\TL\Api\upload\InputFileLocation([
            'id' => $videoMeta['tg_doc_id'],
            'access_hash' => $videoMeta['tg_access_hash'],
            'file_reference' => $videoMeta['tg_file_ref'] ?? '',
            'thumbnail' => null,
        ]);

        $request = new \danog\MadelineProto\TL\Api\upload\GetFile([
            'location' => $location,
            'offset' => $offset,
            'limit' => $limit,
        ]);

        $result = $client->invoke($request);

        if ($result && !empty($result['data'])) {
            yield $result['data'];
        }

        $offset += $limit;
    }
}

// === Send/Upload Operations ===

// Send message to channel
function tg_send_message($channel, $text) {
    $client = tg_connect();
    $request = new \danog\MadelineProto\TL\Api\messages\SendMessage([
        'peer' => $channel,
        'message' => $text,
        'parse_mode' => 'HTML',
    ]);
    return $client->invoke($request);
}

// Send JSON to meta channel
function tg_send_meta($videoData) {
    $json = json_encode($videoData, JSON_PRETTY_PRINT);
    return tg_send_message(TG_CHANNEL_META, $json);
}

// Send JSON to users channel
function tg_send_user($userData) {
    $json = json_encode($userData, JSON_PRETTY_PRINT);
    return tg_send_message(TG_CHANNEL_USERS, $json);
}

// Upload video to Telegram channel
function tg_upload_video($channel, $filePath, $caption = '', $fileName = 'video.mp4') {
    $client = tg_connect();

    // Upload file
    $uploaded = $client->messages->uploadMedia([
        'file' => $filePath,
        'thumb' => null,
    ]);

    // Send to channel
    $request = new \danog\MadelineProto\TL\Api\messages\SendMedia([
        'peer' => $channel,
        'media' => new \danog\MadelineProto\TL\Api\InputMediaUploadedDocument([
            'id' => $uploaded['id'],
            'thumb' => null,
            'caption' => $caption,
            'mime_type' => 'video/mp4',
            'file_name' => $fileName,
        ]),
    ]);

    return $client->invoke($request);
}

// === Video Processing ===

// Process video for fast-start (ffmpeg)
function tg_process_fast_start($inputPath, $outputPath) {
    if (!defined('FFMPEG_PATH') || !function_exists('shell_exec')) {
        return false;
    }

    $cmd = escapeshellarg(FFMPEG_PATH) . ' -i ' . escapeshellarg($inputPath)
        . ' -c copy -movflags faststart ' . escapeshellarg($outputPath)
        . ' 2>&1';

    $output = shell_exec($cmd);

    return file_exists($outputPath);
}

// Get video duration
function tg_get_duration($filePath) {
    if (!defined('FFPROBE_PATH') || !function_exists('shell_exec')) {
        return 0;
    }

    $cmd = escapeshellarg(FFPROBE_PATH) . ' -v error -show_entries format=duration -of csv=p=0 ' . escapeshellarg($filePath);
    $duration = trim(shell_exec($cmd));
    return (int) $duration;
}
