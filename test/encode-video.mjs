import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve('test/video');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta.json'), 'utf8'));
const { frames, scanStart, scanEnd } = meta;

const SPEED = 2.5;
const t = (x) => {
  if (x <= scanStart) return x;
  if (x <= scanEnd) return scanStart + (x - scanStart) / SPEED;
  return scanStart + (scanEnd - scanStart) / SPEED + (x - scanEnd);
};

const lines = [];
let prev = 0;
for (let i = 0; i < frames.length; i += 1) {
  const cur = frames[i];
  const next = frames[i + 1];
  const start = t(cur.t);
  const end = next ? t(next.t) : start + 2.4;
  const d = Math.max(end - start, 0.001);
  prev += d;
  lines.push(`file '${path.resolve(ROOT, cur.name).replace(/\\/g, '/')}'`, `duration ${d.toFixed(4)}`);
}
lines.push(`file '${path.resolve(ROOT, frames[frames.length - 1].name).replace(/\\/g, '/')}'`);
fs.writeFileSync(path.join(ROOT, 'list.txt'), lines.join('\n'));
console.log(`frames=${frames.length} duration≈${prev.toFixed(2)}s`);

const ffmpeg = path.resolve('node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe');
const out = path.resolve('docs/video/dotradar-intro.mp4');
fs.mkdirSync(path.dirname(out), { recursive: true });

const fadeOut = Math.max(0, prev - 0.7).toFixed(2);
const vf = `fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOut}:d=0.7,scale=1600:900,format=yuv420p`;

const res = spawnSync(ffmpeg, [
  '-y', '-f', 'concat', '-safe', '0', '-i', path.join(ROOT, 'list.txt'),
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
  '-shortest', '-vf', vf, '-r', '30',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
  out,
], { stdio: 'inherit' });
console.log('exit', res.status, out);
