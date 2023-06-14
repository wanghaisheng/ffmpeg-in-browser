import isExecutable from '../utils/isExecutable';
import { call as ffmpegCall } from './ffmpegCaller';
import fs from 'fs';
const { spawn } = require('child_process');

const ytDlp = isExecutable('yt-dlp');

const getInfo = (url) => {
  if (!ytDlp?.isExecutable) return;
  return new Promise((resolve) => {
    try {
      const ytDlpProcess = spawn(ytDlp?.path, [url, '-j']);

      let scriptOutput = '';

      ytDlpProcess.stdout.on('data', (data) => {
        data = data.toString();
        scriptOutput += data;
      });

      ytDlpProcess.on('close', () => {
        try {
          const jsonData = JSON.parse(scriptOutput);
          resolve(jsonData);
        } catch {
          resolve(null);
        }
      });
    } catch (err) {
      resolve(null);
      console.error(err);
    }
  });
};

const doDownloadYT = (payload: {
  type: 'vid' | 'gif';
  url: string;
  title: string;
  vQuallity: number | 'best';
  aQuality: number | 'best';
  fileExtension: string;
  path: string;
}) => {
  if (!ytDlp?.isExecutable) return;

  const output = `${payload.path}/${payload.title}.${payload.fileExtension}`;

  return new Promise((resolve) => {
    const getVideoM3u8 = new Promise((resolve, reject) => {
      try {
        const getm3u8 = spawn(ytDlp?.path, ['-f', payload.vQuallity, '-g', payload.url]);
        let m3u8Url = '';
        getm3u8.stdout.on('data', (data) => {
          data = data.toString();
          m3u8Url += data;
        });

        getm3u8.on('close', () => {
          resolve(m3u8Url.replace(/\s\s+/g, ''));
        });
      } catch (err) {
        console.error('getVideoM3u8 ERROR');
        console.error(err);
        reject(err);
      }
    });

    const getAudioM3u8 = new Promise((resolve, reject) => {
      try {
        const getm3u8 = spawn(ytDlp?.path, ['-f', payload.aQuality, '-g', payload.url]);
        let m3u8Url = '';
        getm3u8.stdout.on('data', (data) => {
          data = data.toString();
          m3u8Url += data;
        });

        getm3u8.on('close', () => {
          resolve(m3u8Url.replace(/\s\s+/g, ''));
        });
      } catch (err) {
        console.error('getAudioM3u8 ERROR');
        console.error(err);
        reject(err);
      }
    });

    Promise.all([getVideoM3u8, getAudioM3u8]).then((values) => {
      ffmpegCall([
        '-i',
        values[0],
        '-i',
        values[1],
        '-c',
        'copy',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        output
      ]);
    });
  });
};

const doDownloadDirect = (payload: {
  type: 'vid' | 'gif';
  url: string;
  title: string;
  path: string;
}) => {
  if (!ytDlp?.isExecutable) return;

  const output = `${payload.path}/${payload.title}.mp4`;

  return new Promise((resolve) => {
    try {
      const ytDlpProcess = spawn(ytDlp?.path, [payload.url, '-o', output]);

      let scriptOutput = '';

      ytDlpProcess.stdout.on('data', (data) => {
        data = data.toString();
        scriptOutput += data;
      });

      ytDlpProcess.on('close', () => {
        try {
          console.log(scriptOutput);

          if (payload.type === 'gif') {
            const toGIFProcess = ffmpegCall([
              '-i',
              output,
              '-vf',
              'fps=24,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
              '-loop',
              '0',
              `${payload.path}/${payload.title}.gif`
            ]);

            toGIFProcess.on('close', () => {
              console.log('END: toGIFProcess');
              fs.unlink(output, (err) => {
                if (err) {
                  console.error(err);
                  return;
                }
              });
            });
          }
          resolve(true);
        } catch {
          resolve(null);
        }
      });
    } catch (err) {
      resolve(null);
      console.error(err);
    }
  });
};

export { getInfo, doDownloadYT, doDownloadDirect };
