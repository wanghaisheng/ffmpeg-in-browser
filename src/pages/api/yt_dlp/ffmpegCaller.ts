import isExecutable from '../utils/isExecutable'
const { spawn } = require('child_process')
// https://github.com/7Red4/lil-catcher
const ffmpeg = isExecutable('ffmpeg')

const call = (args) => {
  if (!ffmpeg?.isExecutable) return

  console.log(`applying ffmpeg with args: ${args}`)

  const ffmpegProcess = spawn(ffmpeg?.path, args)

  ffmpegProcess.stdout.on('data', (data) => {
    console.log(data.toString())
  })

  ffmpegProcess.stderr.on('data', (data) => {
    console.log(data.toString())
  })

  ffmpegProcess.on('close', (code) => {
    console.log(`child process exited with code ${code}`)
  })

  return ffmpegProcess
}

export { call }
