-- Intimora PHP Backend — Database Schema
-- Run this on InfinityFree → MySQL Databases → Create database → Import

CREATE DATABASE IF NOT EXISTS intimora;
USE intimora;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    tg_phone VARCHAR(32),
    name VARCHAR(128),
    username VARCHAR(64),
    referral_code VARCHAR(32) UNIQUE,
    referred_by VARCHAR(64),
    likes INT DEFAULT 0,
    saves INT DEFAULT 0,
    created_at INT,
    updated_at INT
);

-- Videos table
CREATE TABLE IF NOT EXISTS videos (
    id VARCHAR(64) PRIMARY KEY,
    title TEXT,
    description TEXT,
    exclusive TINYINT(1) DEFAULT 0,
    views INT DEFAULT 0,
    likes INT DEFAULT 0,
    shares INT DEFAULT 0,
    duration INT DEFAULT 0,
    created_at INT,
    tg_doc_id VARCHAR(64),
    tg_access_hash VARCHAR(128),
    tg_file_ref TEXT,
    tg_size INT,
    tg_mime VARCHAR(64),
    tg_channel VARCHAR(64),
    tg_msg_id INT,
    tg_filename VARCHAR(256),
    thumb_doc_id VARCHAR(64),
    thumb_access_hash VARCHAR(128),
    thumb_file_ref TEXT,
    thumb_size INT,
    thumb_msg_id INT,
    is_fast_start TINYINT(1) DEFAULT 0,
    liked_by TEXT,
    saved_by TEXT
);

-- Likes table
CREATE TABLE IF NOT EXISTS video_likes (
    video_id VARCHAR(64),
    user_id VARCHAR(64),
    PRIMARY KEY (video_id, user_id)
);

-- Saves table
CREATE TABLE IF NOT EXISTS video_saves (
    video_id VARCHAR(64),
    user_id VARCHAR(64),
    PRIMARY KEY (video_id, user_id)
);

-- Views table (for tracking)
CREATE TABLE IF NOT EXISTS video_views (
    video_id VARCHAR(64),
    user_id VARCHAR(64),
    viewed_at INT,
    INDEX idx_video (video_id),
    INDEX idx_user (user_id)
);
