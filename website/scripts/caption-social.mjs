import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
const media=path.resolve('public/media');
const receipt=JSON.parse(await fs.readFile(path.join(media,'tour-recording.json'),'utf8'));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'rig-os-captions-'));
const stamp=s=>{const ms=Math.floor(s*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
await fs.writeFile(path.join(temp,'captions.srt'),receipt.cues.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'));
await new Promise((resolve,reject)=>{
  const process=spawn(ffmpeg,['-y','-i',path.join(media,'rig-os-tour.mp4'),'-vf',"pad=1600:1120:0:0:color=0x0b1517,subtitles=captions.srt:force_style='FontName=Segoe UI,FontSize=10,PrimaryColour=&H00E9EEE8,OutlineColour=&H0017150B,BorderStyle=1,Outline=1,Shadow=0,MarginV=8,Alignment=2'",'-an','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',path.join(media,'rig-os-social.mp4')],{cwd:temp,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let error='';process.stderr.on('data',d=>error+=d);process.on('error',reject);process.on('close',code=>code===0?resolve():reject(new Error(error)));
});
console.log('Social captions rendered');
