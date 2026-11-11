<?php
// Intimora PHP Backend — MTProto Client (MadelineProto)
// Same session string as Node.js teleproto — full MTProto support
// LOCK MECHANISM — prevents concurrent session usage (same as Node.js backend)

require_once __DIR__ . '/config.php';

class MTProtoClient {
    private $apiId;
    private $apiHash;
    private $session;
    private $client = null;
    private $loop = null;

    // === LOCK MECHANISM ===
    // Prevents multiple clients being created with same session
    // (causes "Concurrent usage" error from Telegram)
    private static $lockHeld = false;
    private static $lockQueue = [];

    public function __construct($apiId, $apiHash, $session) {
        $this->apiId = $apiId;
        $this->apiHash = $apiHash;
        $this->session = $session;
    }

    /**
     * Acquire lock — only one client creation at a time
     */
    public static function acquireLock() {
        // If lock already held, queue this request
        if (self::$lockHeld) {
            $queue = &self::$lockQueue;
            $event = new Event();
            $queue[] = $event;
            return $event;
        }
        // Lock acquired
        self::$lockHeld = true;
        return null;
    }

    /**
     * Release lock — allow next queued request to proceed
     */
    public static function releaseLock() {
        // Process next in queue
        if (!empty(self::$lockQueue)) {
            $event = array_shift(self::$lockQueue);
            self::$lockHeld = false;
            // Signal the waiting event
            if ($event) {
                $event->signal();
            }
        } else {
            self::$lockHeld = false;
        }
    }

    /**
     * Simple event/semaphore for queueing
     */
    public function connect() {
        // Acquire lock to prevent concurrent client creation
        $lockEvent = self::acquireLock();
        try {
            // If another request is already creating client, wait
            if ($lockEvent) {
                $lockEvent->wait();
            }

            // Re-check after acquiring lock (another request may have already created client)
            if ($this->client !== null) {
                return;
            }

            // MadelineProto factory
            $factory = new \danog\MadelineProto\Factory([
                'api_id' => $this->apiId,
                'api_hash' => $this->apiHash,
                'session' => $this->session,
                'connection_settings' => [
                    'connection_retries' => 5,
                ],
            ]);

            $this->client = $factory->create();

            // Connection is handled by MadelineProto automatically
            // The session is already authorized (saved from Node.js login)

        } finally {
            // Always release lock
            self::releaseLock();
        }
    }

    public function isConnected() {
        return $this->client !== null;
    }

    public function isUserAuthorized() {
        if (!$this->client) return false;
        return true;
    }

    public function invoke($request) {
        if (!$this->client) {
            throw new Exception('Client not connected');
        }
        return $this->client->invoke($request);
    }

    public function getInputEntity($channel) {
        if (!$this->client) {
            throw new Exception('Client not connected');
        }
        return $this->client->users->getInputEntity($channel);
    }

    public function downloadMedia($msg, $opts = []) {
        if (!$this->client) {
            throw new Exception('Client not connected');
        }
        return $this->client->messages->downloadMedia($msg, $opts);
    }

    public function disconnect() {
        if ($this->client) {
            $this->client->disconnect();
            $this->client = null;
        }
    }
}

/**
 * Simple Event class for lock queueing
 */
class Event {
    private $signaled = false;

    public function signal() {
        $this->signaled = true;
    }

    public function wait() {
        // In PHP, we use a simple busy-wait or sleep
        // In production, use a proper async mechanism
        while (!$this->signaled) {
            usleep(1000); // 1ms sleep
        }
    }

    public function isSignaled() {
        return $this->signaled;
    }
}

// Promise class for async operations
class Promise {
    private $resolve;
    private $reject;
    private $fulfilled = false;
    private $result;

    public function __construct(callable $resolver) {
        $this->resolve = $resolver;
        $resolver($this);
    }

    public function then(callable $onFulfilled) {
        if ($this->fulfilled) {
            $onFulfilled($this->result);
        }
        return $this;
    }

    public function resolve($value) {
        $this->fulfilled = true;
        $this->result = $value;
    }

    public function reject($error) {
        $this->fulfilled = false;
        $this->result = $error;
    }
}

// === MTProto Functions (mirrors Node.js teleproto API) ===

// Global client instance
$mtprotoClient = null;

function mtproto() {
    global $mtprotoClient;
    if ($mtprotoClient === null) {
        $mtprotoClient = new MTProtoClient(TG_API_ID, TG_API_HASH, TELEGRAM_SESSION);
    }
    return $mtprotoClient;
}

// Connect to Telegram
function mtproto_connect() {
    $client = mtproto();
    if (!$client->isConnected()) {
        $client->connect();
    }
    return $client;
}

// Get history from channel
function mtproto_get_history($channel, $limit = 200, $offsetId = null) {
    $client = mtproto_connect();
    $inputEntity = $client->getInputEntity($channel);

    // Use messages.GetHistory
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

// Get file for streaming
function mtproto_get_file($videoMeta, $offset, $limit) {
    $client = mtproto_connect();

    // Build input file location
    $location = new \danog\MadelineProto\TL\Api\upload\InputFileLocation([
        'id' => $videoMeta['tg_doc_id'],
        'access_hash' => $videoMeta['tg_access_hash'],
        'file_reference' => $videoMeta['tg_file_ref'] ?? '',
        'thumbnail' => null,
    ]);

    // Use upload.GetFile
    $request = new \danog\MadelineProto\TL\Api\upload\GetFile([
        'location' => $location,
        'offset' => $offset,
        'limit' => $limit,
    ]);

    return $client->invoke($request);
}

// Download media to file
function mtproto_download_media($msg, $outputFile) {
    $client = mtproto_connect();
    return $client->downloadMedia($msg, ['outputFile' => $outputFile]);
}

// Send message to channel
function mtproto_send_message($channel, $text) {
    $client = mtproto_connect();
    $request = new \danog\MadelineProto\TL\Api\messages\SendMessage([
        'peer' => $channel,
        'message' => $text,
        'parse_mode' => 'HTML',
    ]);
    return $client->invoke($request);
}

// Upload video to channel
function mtproto_upload_video($channel, $filePath, $caption, $fileName) {
    $client = mtproto_connect();

    // Upload file first
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

// Read file range (for streaming)
function mtproto_read_file_range($videoMeta, $start, $end) {
    $client = mtproto_connect();
    $chunkSize = 512 * 1024; // 512KB

    $data = '';
    $currentOffset = $start;

    while ($currentOffset <= $end) {
        $limit = min($chunkSize, $end - $currentOffset + 1);
        $result = mtproto_get_file($videoMeta, $currentOffset, $limit);

        if (!$result || empty($result['data'])) {
            break;
        }

        $data .= $result['data'];
        $currentOffset += $limit;
    }

    return $data;
}

// Find moov atom in MP4 file
function mtproto_find_moov_atom($videoMeta, $filePath) {
    // First check if file exists locally
    if (!file_exists($filePath)) {
        return null;
    }

    $fh = fopen($filePath, 'rb');
    if (!$fh) return null;

    // Read first 32 bytes for ftyp
    $header = fread($fh, 32);
    if (strpos($header, 'ftyp') === false) {
        fclose($fh);
        return null;
    }

    // Find moov atom
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
            $moovStart = $offset;
            fseek($fh, $moovStart);
            $data = fread($fh, $size);
            fclose($fh);
            return ['start' => $moovStart, 'size' => $size, 'data' => $data];
        }

        if ($size <= 0) break;
        $offset += $size;
    }

    fclose($fh);
    return null;
}
