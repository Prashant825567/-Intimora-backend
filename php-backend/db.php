<?php
// Intimora PHP Backend — Database Connection
require_once __DIR__ . '/config.php';

function db() {
    static $conn = null;
    if ($conn === null) {
        $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
        if ($conn->connect_error) {
            http_response_code(500);
            echo json_encode(['ok' => false, 'error' => 'DB connection failed: ' . $conn->connect_error]);
            exit;
        }
        $conn->set_charset('utf8mb4');
    }
    return $conn;
}

function db_query($sql, $params = []) {
    $conn = db();
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        return null;
    }
    $types = '';
    $args = [];
    foreach ($params as $i => $v) {
        $types .= is_int($v) ? 'i' : (is_float($v) ? 'd' : 's');
        $args[] = &$params[$i];
    }
    array_unshift($args, $types);
    $stmt->execute(...$args);
    return $stmt;
}

function db_fetch_all($sql, $params = []) {
    $stmt = db_query($sql, $params);
    if (!$stmt) return [];
    $result = $stmt->get_result();
    return $result ? $result->fetch_all(MYSQLI_ASSOC) : [];
}

function db_fetch_one($sql, $params = []) {
    $rows = db_fetch_all($sql, $params);
    return $rows[0] ?? null;
}

function db_insert($sql, $params = []) {
    $stmt = db_query($sql, $params);
    if (!$stmt) return false;
    return $stmt->insert_id;
}

function db_update($sql, $params = []) {
    $stmt = db_query($sql, $params);
    if (!$stmt) return false;
    return $stmt->affected_rows;
}

function db_delete_row($sql, $params = []) {
    $stmt = db_query($sql, $params);
    if (!$stmt) return false;
    return $stmt->affected_rows;
}

// Cache helper (60 seconds)
function cache_get($key) {
    global $cacheDir;
    $file = $cacheDir . '/' . md5($key) . '.json';
    if (file_exists($file) && (time() - filemtime($file)) < 60) {
        return json_decode(file_get_contents($file), true);
    }
    return null;
}

function cache_set($key, $data) {
    global $cacheDir;
    $file = $cacheDir . '/' . md5($key) . '.json';
    file_put_contents($file, json_encode($data), LOCK_EX);
}

function cache_clear($prefix = '') {
    global $cacheDir;
    foreach (glob($cacheDir . '/*.json') as $file) {
        $name = basename($file, '.json');
        if ($prefix === '' || strpos(md5($prefix), $name) === 0) {
            unlink($file);
        }
    }
}
