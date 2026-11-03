import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BUILD = path.resolve('test/video2');
const OUT = path.resolve('docs/video/dotradar-tour.mp4');
const FFMPEG = path.resolve('node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe');
const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'meta.json'), 'utf8'));
const { frames } = meta;
const total = frames[frames.length - 1].t + 1.2;

const list = [];
for (let i = 0; i < frames.length; i += 1) {
  const cur = frames[i];
  const next = frames[i + 1];
  const d = Math.max((next ? next.t : cur.t + 1.0) - cur.t, 0.001);
  list.push(`file '${cur.name}'`, `duration ${d.toFixed(4)}`);
}
list.push(`file '${frames[frames.length - 1].name}'`);
fs.writeFileSync(path.join(BUILD, 'list.txt'), list.join('\n'));
console.log('frames', frames.length, 'total', total.toFixed(2));

const fadeOutStart = Math.max(0, total - 0.8).toFixed(2);
const vf = `fade=t=in:st=0:d=0.6,fade=t=out:st=${fadeOutStart}:d=0.8,scale=1920:1080,format=yuv420p`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const res = spawnSync(FFMPEG, [
  '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
  '-i', 'mix.wav',
  '-vf', vf, '-r', '30',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
  '-movflags', '+faststart', '-shortest',
  OUT,
], { stdio: 'inherit', cwd: BUILD });
console.log('ffmpeg', res.status, OUT);
