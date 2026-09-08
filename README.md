# HLS → MP4 converter

Paste a watch-page URL. The server loads the page in a headless browser, listens for the same `/api/v1/episodes/<id>/sources` network response that DevTools shows, extracts `sources[].file`, fetches `index.json`, resolves relative segment URLs, then runs FFmpeg with H.264/AAC and `+faststart`.

## Requirements
- Node.js 18+
- FFmpeg + ffprobe with libx264/AAC

## Install
`npm install`
`npx playwright install chromium`

## Run
`npm start`
Then open `http://localhost:3000`.

Set `FFMPEG_PATH` / `FFPROBE_PATH` if they are not on PATH.

Use only on sites/media you are authorized to process.
