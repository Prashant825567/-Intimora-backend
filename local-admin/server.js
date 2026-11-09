// Local Admin Server — runs on your PC, no cloud server needed
// Upload videos to Telegram via MTProto directly
// Saves metadata to local file (no bandwidth, no server cost)

const express = require('express');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { Api } = require('teleproto');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

// === FFmpeg Check & Auto-Install ===
let ffmpegAvailable = false;
let ffmpegPath = null;

function checkFFmpeg() {
  // Method 1: Check if ffmpeg is already in PATH
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    ffmpegAvailable = true;
    console.log('✅ ffmpeg found in PATH');
    return;
  } catch {}

  // Method 2: Try ffmpeg-static npm package (pre-built binary, most reliable)
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) {
      // Test the binary
      try {
        execSync(`"${ffmpegStatic}" -version`, { stdio: 'pipe' });
        ffmpegAvailable = true;
        ffmpegPath = ffmpegStatic;
        console.log('✅ ffmpeg found via ffmpeg-static package');
        return;
      } catch (e) {
        console.log('⚠️ ffmpeg-static binary exists but failed:', e.message);
      }
    }
  } catch (e) {
    console.log('⚠️ ffmpeg-static not installed');
  }

  // Method 3: Try system package managers
  const os = require('os');
  const platform = os.platform();

  try {
    if (platform === 'win32') {
      // Try winget, choco, scoop
      const commands = [
        'winget install ffmpeg -y',
        'choco install ffmpeg -y',
        'scoop install ffmpeg',
      ];
      for (const cmd of commands) {
        try {
          execSync(cmd, { stdio: 'pipe', timeout: 120000 });
          // Re-check
          execSync('ffmpeg -version', { stdio: 'pipe' });
          ffmpegAvailable = true;
          console.log(`✅ ffmpeg installed via ${cmd.split(' ')[0]}`);
          return;
        } catch {}
      }
    } else if (platform === 'darwin') {
      execSync('brew install ffmpeg', { stdio: 'pipe', timeout: 120000 });
      execSync('ffmpeg -version', { stdio: 'pipe' });
      ffmpegAvailable = true;
      console.log('✅ ffmpeg installed via brew');
      return;
    } else {
      execSync('apt-get install -y ffmpeg || sudo apt-get install -y ffmpeg', { stdio: 'pipe', timeout: 120000 });
      execSync('ffmpeg -version', { stdio: 'pipe' });
      ffmpegAvailable = true;
      console.log('✅ ffmpeg installed via apt-get');
      return;
    }
  } catch (e) {
    console.log('❌ System package manager install failed:', e.message);
  }

  // Method 4: Try installing ffmpeg-static via npm
  try {
    console.log('⚠️ Attempting npm install of ffmpeg-static...');
    execSync('npm install ffmpeg-static', { cwd: __dirname, stdio: 'pipe', timeout: 120000 });
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) {
      execSync(`"${ffmpegStatic}" -version`, { stdio: 'pipe' });
      ffmpegAvailable = true;
      ffmpegPath = ffmpegStatic;
      console.log('✅ ffmpeg installed via npm ffmpeg-static');
      return;
    }
  } catch (e) {
    console.log('❌ npm install failed:', e.message);
  }

  console.log('❌ All installation methods failed');
  console.log('   Manual install: https://ffmpeg.org/download.html');
  console.log('   Or run: npm install ffmpeg-static');
}

// Check on startup
checkFFmpeg();

// === Config (all pre-filled) ===
const config = {
  apiId: 37144075,
  apiHash: '57a11adf8679a2e7a2b6184ed7bb9c70',
  session: '1BVtsOKoBu4z3rpa0oaf6typE-B_uQjsppHZPMXxuqK7PqNgCglMysl_0IqfYcF9LVaXFvNXfGmlWYN_uO-vDzqcRjneSbfvIvMxJFzQ0SV6b0F4ZU-hCqtRujbQNLm1y9JNaHjV-_7Qg8E_HTmYy249p6HpllEplMQwQpTCkca_03e6Jx1pX79illr-U1TDX62mNB6IDBsmMyHoKDa1cEZ77Sd7g0OC5qiCpSEZ7xmpx-EIZnL9kl7ywVk1kCHg6ghnsMCI7FEr7Mvnni29lcLkfU375QGRnBSQe6SYefBo24X_-U1NEYEmbWXLV_e0galImFTRXT76AMpjgLj0CRBWmlOQxYdM=',
  videoChannel: '-1003756299546',
  thumbChannel: '-1004360811639',
  metaChannel: '-1003777974779',
};

const META_FILE = path.join(__dirname, 'metadata.json');
let localMetadata = [];

if (fs.existsSync(META_FILE)) {
  localMetadata = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
}

function saveMetadata() {
  fs.writeFileSync(META_FILE, JSON.stringify(localMetadata, null, 2));
}

// === Get duration from MP4 file ===
function getVideoDuration(buffer) {
  try {
    // Read mvhd atom from MP4
    let offset = 0;
    while (offset < buffer.length - 8) {
      const size = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (type === 'mvhd') {
        const timescale = buffer.readUInt32BE(offset + 20);
        const duration = buffer.readUInt32BE(offset + 24);
        return Math.floor(duration / timescale);
      }
      if (size === 0) break;
      offset += size;
    }
  } catch (e) {
    // Ignore
  }
  return 0;
}

// === Telegram Client ===
const session = new StringSession(config.session);
const tg = new TelegramClient(session, config.apiId, config.apiHash, {
  connectionRetries: 5,
});

// === Check MP4 file structure — is moov at beginning or end? ===
function checkFileStructure(buffer) {
  try {
    // Parse atoms from the beginning (first 64KB should have ftyp + maybe moov)
    let offset = 0;
    let moovAtStart = false;
    let mdatFound = false;

    while (offset < buffer.length - 8 && offset < 65536) {
      const size = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);

      if (type === 'moov') {
        moovAtStart = true;
        break;
      }
      if (type === 'mdat') {
        mdatFound = true;
        break;
      }
      if (size === 0 || size < 8) break;
      offset += size;
    }

    // If mdat found before moov, moov is at the end (needs processing)
    // If moov found before mdat, fast-start already OK
    return {
      fastStart: moovAtStart,
      needsProcessing: mdatFound && !moovAtStart,
    };
  } catch {
    // Not an MP4 or can't parse — assume needs processing
    return { fastStart: false, needsProcessing: true, error: 'Cannot parse file structure' };
  }
}

// === Process video with ffmpeg — move moov to beginning ===
function processVideoFastStart(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpegCmd = ffmpegPath || 'ffmpeg';
    const cmd = `"${ffmpegCmd}" -i "${inputPath}" -c copy -movflags faststart "${outputPath}"`;
    const child = exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`ffmpeg failed: ${error.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// === Download video from Telegram ===
async function downloadVideoFromTelegram(videoMeta) {
  if (!tg.isConnected || !tg.isConnected()) await tg.connect();
  const inputVideo = await tg.getInputEntity(config.videoChannel);
  // Use GetHistory with maxId to fetch a specific message (avoids channels.GetMessages unsupported error)
  const result = await tg.invoke(new Api.messages.GetHistory({
    peer: inputVideo,
    limit: 1,
    maxId: BigInt(videoMeta.video.tg_msg_id),
    minId: 0,
    addOffset: 0,
  }));
  if (!result.messages || result.messages.length === 0) throw new Error('Message not found in Telegram');
  const msg = result.messages[0];
  if (msg.id !== Number(videoMeta.video.tg_msg_id)) throw new Error(`Message ID mismatch: expected ${videoMeta.video.tg_msg_id}, got ${msg.id}`);
  const tempPath = path.join(os.tmpdir(), `download-${Date.now()}.mp4`);
  await tg.downloadMedia(msg, { outputFile: tempPath });
  return tempPath;
}

// === Sync videos from Telegram video channel ===
async function syncVideosFromTelegram() {
  console.log('Step 1: Getting input entity...');
  const inputChannel = await tg.getInputEntity(config.videoChannel);
  console.log('Step 2: Input entity resolved');

  const tgVideos = [];
  let offsetId = null;
  let totalFetched = 0;
  let totalVideos = 0;

  // Paginate through all messages using messages.GetHistory
  for (let page = 0; page < 50; page++) {
    console.log(`Page ${page + 1}: fetching messages...`);
    const result = await tg.invoke(new Api.messages.GetHistory({
      peer: inputChannel,
      limit: 200,
      offsetId: offsetId ? BigInt(offsetId) : undefined,
      maxId: undefined,
      minId: 0,
      addOffset: 0,
    }));

    if (!result.messages || result.messages.length === 0) {
      console.log('No more messages');
      break;
    }

    console.log(`Page ${page + 1}: got ${result.messages.length} messages`);

    for (const msg of result.messages) {
      totalFetched++;
      if (msg.document && msg.document.mimeType && msg.document.mimeType.startsWith('video/')) {
        const refToBase64 = (ref) => ref ? ref.toString('base64') : '';
        tgVideos.push({
          id: `tg-${msg.id}`,
          title: msg.message || msg.caption || msg.document?.fileName || 'Untitled',
          description: '',
          exclusive: false,
          duration: 0,
          views: 0,
          likes: 0,
          shares: 0,
          likedBy: [],
          video: {
            tg_doc_id: String(msg.document.id),
            tg_access_hash: String(msg.document.accessHash),
            tg_file_ref: refToBase64(msg.document.fileReference),
            tg_size: msg.document.size,
            tg_mime: msg.document.mimeType,
            tg_channel: config.videoChannel,
            tg_msg_id: msg.id,
            tg_filename: msg.document.fileName || 'video.mp4',
          },
          thumbnail: {
            thumb_doc_id: '',
            thumb_access_hash: '',
            thumb_file_ref: '',
            thumb_size: 0,
            thumb_msg_id: null,
          },
          is_fast_start: true,
          createdAt: msg.date ? (typeof msg.date === 'number' ? msg.date > 1e12 ? Math.floor(msg.date / 1000) : msg.date : msg.date.getTime ? Math.floor(msg.date.getTime() / 1000) : Math.floor(Date.now() / 1000)) : Math.floor(Date.now() / 1000),
        });
        totalVideos++;
      }
    }

    const oldestMsg = result.messages[0];
    if (!oldestMsg) break;
    offsetId = oldestMsg.id;

    if (result.messages.length < 200) break;
  }

  console.log(`Fetched ${totalFetched} messages, found ${totalVideos} videos`);

  // Merge with local metadata — match by tg_msg_id
  const localMsgIds = new Set(localMetadata.map(v => v.video?.tg_msg_id));
  const tgMsgIds = new Set(tgVideos.map(v => v.video.tg_msg_id));

  // Add Telegram videos that are not in local metadata
  const newVideos = tgVideos.filter(v => !localMsgIds.has(v.video.tg_msg_id));
  console.log(`${newVideos.length} new videos to add`);

  localMetadata = [...newVideos, ...localMetadata];
  saveMetadata();

  return { total: localMetadata.length, added: newVideos.length };
}

// === Reprocess video — download → ffmpeg → re-upload ===
async function reprocessVideo(videoId) {
  const videoMeta = localMetadata.find(v => v.id === videoId);
  if (!videoMeta) throw new Error('Video not found');

  console.log(`🔄 Reprocessing: ${videoMeta.title}`);

  // Step 1: Download from Telegram
  console.log('  Step 1: Downloading from Telegram...');
  const downloadedPath = await downloadVideoFromTelegram(videoMeta);

  // Step 2: Check file structure
  const fileBuffer = fs.readFileSync(downloadedPath);
  const headBuffer = fileBuffer.subarray(0, Math.min(65536, fileBuffer.length));
  const fileStructure = checkFileStructure(headBuffer);

  if (fileStructure.fastStart) {
    console.log('  ✅ Already fast-start — no processing needed');
    fs.unlinkSync(downloadedPath);
    return { ok: true, message: 'Already optimized', needsProcessing: false };
  }

  // Step 3: Process with ffmpeg
  console.log('  Step 2: Processing with ffmpeg...');
  const processedPath = path.join(os.tmpdir(), `reprocessed-${Date.now()}.mp4`);
  await processVideoFastStart(downloadedPath, processedPath);
  fs.unlinkSync(downloadedPath); // delete original

  // Step 4: Re-upload to Telegram
  console.log('  Step 3: Re-uploading to Telegram...');
  if (!ffmpegAvailable) throw new Error('ffmpeg not available');
  if (!tg.isConnected || !tg.isConnected()) await tg.connect();

  const inputVideo = await tg.getInputEntity(config.videoChannel);
  const thumbPath = path.join(os.tmpdir(), `thumb-${Date.now()}.jpg`);
  // Download existing thumbnail
  try {
    const thumbMsg = await tg.getMessages(config.thumbChannel, { ids: [videoMeta.thumbnail.thumb_msg_id] });
    if (thumbMsg && thumbMsg.length > 0) {
      await tg.downloadMedia(thumbMsg[0], { outputFile: thumbPath });
    }
  } catch {}

  const videoMsg = await tg.sendFile(inputVideo, {
    file: processedPath,
    caption: videoMeta.title,
    forceDocument: true,
    thumb: fs.existsSync(thumbPath) ? thumbPath : undefined,
    workers: 4,
  });

  // Step 5: Delete old video message from Telegram
  console.log('  Step 4: Deleting old video message...');
  try {
    await tg.deleteMessages(config.videoChannel, [videoMeta.video.tg_msg_id]);
  } catch (e) {
    console.log('  ⚠️ Could not delete old message:', e.message);
  }

  // Step 6: Update metadata
  const doc = videoMsg.document;
  const refToBase64 = (ref) => ref ? ref.toString('base64') : '';

  const updatedMeta = {
    ...videoMeta,
    video: {
      tg_doc_id: doc?.id ? String(doc.id) : '',
      tg_access_hash: doc?.accessHash ? String(doc.accessHash) : '',
      tg_file_ref: refToBase64(doc?.fileReference),
      tg_size: doc?.size || fs.statSync(processedPath).size,
      tg_mime: doc?.mimeType || 'video/mp4',
      tg_channel: config.videoChannel,
      tg_msg_id: videoMsg.id,
      tg_filename: videoMeta.video.tg_filename || 'video.mp4',
    },
  };

  // Update in local metadata
  const idx = localMetadata.findIndex(v => v.id === videoId);
  localMetadata[idx] = updatedMeta;
  saveMetadata();

  // Step 7: Cleanup
  if (fs.existsSync(processedPath)) fs.unlinkSync(processedPath);
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

  console.log('✅ Reprocess complete!');
  return { ok: true, message: 'Video reprocessed successfully', needsProcessing: true };
}

// === Express ===
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2000 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, data: { status: 'up', ffmpeg: ffmpegAvailable } });
});

// FFmpeg status
app.get('/api/ffmpeg-status', (req, res) => {
  res.json({ ok: true, data: { available: ffmpegAvailable } });
});

// Videos list
app.get('/api/videos', (req, res) => {
  res.json({ ok: true, data: { videos: localMetadata, nextCursor: null } });
});

// Upload
app.post('/api/upload', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumb', maxCount: 1 },
]), async (req, res) => {
  let videoPath, thumbPath;
  try {
    const title = req.body.title;
    const description = req.body.description;
    const videoFile = req.files.video?.[0];
    const thumbFile = req.files.thumb?.[0];

    if (!title) return res.status(400).json({ ok: false, error: 'Title required' });
    if (!videoFile) return res.status(400).json({ ok: false, error: 'Video required' });
    if (!thumbFile) return res.status(400).json({ ok: false, error: 'Thumbnail required' });

    // Auto-detect duration from video file
    let duration = parseInt(req.body.duration) || 0;
    if (duration === 0) {
      duration = getVideoDuration(videoFile.buffer);
    }

    // Write to temp files
    videoPath = path.join(os.tmpdir(), `video-${Date.now()}.mp4`);
    fs.writeFileSync(videoPath, videoFile.buffer);

    thumbPath = path.join(os.tmpdir(), `thumb-${Date.now()}.jpg`);
    fs.writeFileSync(thumbPath, thumbFile.buffer);

    // ---- Check file structure — is moov at beginning or end? ----
    // Read first 64KB of file to check atom order
    const fileBuffer = fs.readFileSync(videoPath);
    const headBuffer = fileBuffer.subarray(0, Math.min(65536, fileBuffer.length));
    const fileStructure = checkFileStructure(headBuffer);

    let processedVideoPath = videoPath;

    // ---- If moov is at end, process with ffmpeg to move it to beginning ----
    if (fileStructure.needsProcessing && ffmpegAvailable) {
      try {
        const processedPath = path.join(os.tmpdir(), `video-processed-${Date.now()}.mp4`);
        await processVideoFastStart(videoPath, processedPath);

        // Replace with processed file
        if (fs.existsSync(processedPath)) {
          fs.unlinkSync(videoPath); // delete original
          processedVideoPath = processedPath;
          videoPath = processedPath;
          console.log('✅ Fast-start processing complete');
        }
      } catch (e) {
        console.log('⚠️ Fast-start processing failed:', e.message);
        console.log('   Uploading original file (moov at end)');
      }
    } else if (fileStructure.needsProcessing && !ffmpegAvailable) {
      console.log('⚠️ ffmpeg not available — skipping fast-start processing');
    } else if (fileStructure.fastStart) {
      console.log('✅ Fast-start already OK — no processing needed');
    }

    // Connect client if needed
    if (!tg.isConnected || !tg.isConnected()) {
      await tg.connect();
    }

    // Resolve channel entity (caches access_hash)
    const inputVideo = await tg.getInputEntity(config.videoChannel);
    const inputThumb = await tg.getInputEntity(config.thumbChannel);
    const inputMeta = await tg.getInputEntity(config.metaChannel);

    // Upload video to Telegram (with thumbnail attached)
    const videoMsg = await tg.sendFile(inputVideo, {
      file: videoPath,
      caption: title,
      forceDocument: true,
      thumb: thumbPath,
      workers: 4,
    });

    // Upload thumbnail as separate photo to thumbnail channel
    const thumbMsg = await tg.sendFile(inputThumb, {
      file: thumbPath,
      forceDocument: false,
      workers: 2,
    });

    // Build metadata
    const doc = videoMsg.document;
    const photo = thumbMsg.photo;

    const refToBase64 = (ref) => ref ? ref.toString('base64') : '';

    const metadata = {
      t: 'meta',
      id: `local-${Date.now()}`,
      title: title,
      description: description || '',
      exclusive: req.body.exclusive === 'true' || req.body.exclusive === true,
      views: 0,
      likes: 0,
      shares: 0,
      likedBy: [],
      duration: duration,
      createdAt: Math.floor(Date.now() / 1000),
      video: {
        tg_doc_id: doc?.id ? String(doc.id) : '',
        tg_access_hash: doc?.accessHash ? String(doc.accessHash) : '',
        tg_file_ref: refToBase64(doc?.fileReference),
        tg_size: doc?.size || videoFile.size,
        tg_mime: doc?.mimeType || 'video/mp4',
        tg_channel: config.videoChannel,
        tg_msg_id: videoMsg.id,
        tg_filename: videoFile.originalname,
      },
      thumbnail: {
        thumb_doc_id: photo?.id ? String(photo.id) : '',
        thumb_access_hash: photo?.accessHash ? String(photo.accessHash) : '',
        thumb_file_ref: refToBase64(photo?.fileReference),
        thumb_size: photo?.size || thumbFile.size,
        thumb_msg_id: thumbMsg.id,
      },
    };

    // Save locally
    localMetadata.unshift(metadata);
    saveMetadata();

    // Send metadata to Telegram as TEXT MESSAGE (not file)
    // Backend reads metadata from text messages, not files
    await tg.sendMessage(inputMeta, { message: JSON.stringify(metadata) });

    // Cleanup temp files
    fs.unlinkSync(videoPath);
    fs.unlinkSync(thumbPath);

    res.json({ ok: true, data: { id: metadata.id, duration: duration, message: 'Upload successful!' } });
  } catch (e) {
    console.error('Upload error:', e.message);
    // Cleanup on error
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete
app.post('/api/delete/:id', (req, res) => {
  localMetadata = localMetadata.filter(v => v.id !== req.params.id);
  saveMetadata();
  res.json({ ok: true, data: { message: 'Deleted' } });
});

// Reprocess — download → ffmpeg → re-upload
app.post('/api/reprocess/:id', async (req, res) => {
  try {
    const result = await reprocessVideo(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sync videos from Telegram
app.post('/api/sync-videos', async (req, res) => {
  console.log('📡 Sync endpoint called');
  try {
    console.log('Checking connection...');
    if (!tg.isConnected || !tg.isConnected()) {
      console.log('Connecting to Telegram...');
      await tg.connect();
    }
    console.log('Connection OK, starting sync...');
    const result = await syncVideosFromTelegram();
    console.log('Sync complete:', result);
    res.json({ ok: true, data: result });
  } catch (e) {
    console.error('Sync error:', e.message, e.stack);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Export
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename=intimora-metadata.json');
  res.json(localMetadata);
});

// Root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎬 Intimora Local Admin`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`\nPress Ctrl+C to stop\n`);
});
