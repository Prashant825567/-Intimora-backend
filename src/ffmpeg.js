// ffmpeg helpers — thumbnail generation + optional faststart remux + duration.
// Uses the bundled ffmpeg-static binary directly via child_process (no ffprobe,
// no fluent-ffmpeg quirks). Works on Render with no system install.
const { execFile } = require("child_process");
const ffmpegBin = require("ffmpeg-static");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const TMP_DIR = path.join(DATA_DIR, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = execFile(ffmpegBin, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "ffmpeg error").toString().slice(0, 300);
        reject(new Error(msg));
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.on("error", reject);
  });
}

// Extract a single thumbnail (640px wide, aspect preserved) at ~10% into the video.
async function generateThumbnail(videoPath, outPath) {
  // -ss before -i = fast seek; scale 640:-2 keeps aspect, even height
  await run([
    "-ss", "1", "-i", videoPath,
    "-frames:v", "1",
    "-vf", "scale=640:-2",
    "-q:v", "3",
    "-y", outPath,
  ]);
  return outPath;
}

// Read duration (seconds) by parsing ffmpeg's stderr "Duration:" line.
async function getDuration(videoPath) {
  try {
    const { stderr } = await run(["-i", videoPath, "-f", "null", "-"]);
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    if (m) return Math.round(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
  } catch {}
  return 0;
}

// Re-mux to MP4 with faststart (moov atom at front). Stream-copy, no re-encode.
// If the input isn't compatible, resolves false so caller keeps the original.
async function faststart(inputPath, outputPath) {
  try {
    await run([
      "-i", inputPath,
      "-c", "copy",
      "-movflags", "faststart",
      "-y", outputPath,
    ]);
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}

module.exports = { generateThumbnail, getDuration, faststart, TMP_DIR, ffmpegBin };
