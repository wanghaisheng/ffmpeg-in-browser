import { invoke, shell } from "@tauri-apps/api"
// https://github.com/stefnotch/downline/tree/a3f1a9b45799463f7a942abe7fd62ad12cd24a94
/**
 * Generates commandline arguments for yt-dl. Optionally also generates ffmpeg arguments.
 */
export class Downloader {
  private readonly runningProcesses = new Map<string, shell.Child>();

  constructor() { }

  /** Video extension */
  static get videoFormats() {
    // Format order taken from https://github.com/yt-dlp/yt-dlp#sorting-formats
    return ["best", "mp4", "webm", "mkv"] as const
  }

  /** Audio extension */
  static get audioFormats() {
    // No idea if I should remove some of those formats
    return [
      "best",
      "m4a",
      "aac",
      "mp3",
      "ogg",
      "opus",
      "webm",
      "flac",
      "vorbis",
      "wav",
    ] as const
  }

  /** Checks if youtube-dl or an alternative exists. Will return the version number, if possible */
  async checkYoutubeDl(pathsToCheck: string[]) {
    for (let i = 0; i < pathsToCheck.length; i++) {
      const youtubeDlVersion = await this.checkIfBinaryExists(pathsToCheck[i], [
        "--version",
      ])
      if (youtubeDlVersion !== null) {
        return {
          binary: pathsToCheck[i],
          version: youtubeDlVersion,
        }
      }
    }

    // TODO: Also check the save file location (where the config file is saved) ^

    return null
  }

  /**
   *
   * @throws an error if youtube-dl is missing
   */
  async fetchInfo(
    url: string,
    path: string,
    dataCallback: (data: DownloadableItem) => void
  ) {
    const args = [
      "--all-subs",
      "--dump-json",
      "--no-playlist",
      "--ignore-errors",
      url,
    ]

    return this.callYoutubeDl(url, path, args, (data) => {
      const item = this.parseDownloadableItem(data)
      if (item && "formats" in item) {
        dataCallback(item)
      }
    })
  }

  /**
   *
   * @throws an error if youtube-dl is missing
   */
  async download(
    item: DownloadableItem,
    downloadOptions: DownloadOptions,
    path: string,
    dataCallback: (data: {
      progress: DownloadProgress | null
      progressStatus: string
      filepath: string | null
    }) => void
  ) {
    const args = await this.downloadArgs(item, downloadOptions)

    return this.callYoutubeDl(item.url, path, args, (data: string) => {
      console.log(data)

      data = ((data ?? "") + "").trimStart()

      let progress: null | DownloadProgress = {
        value: 0,
      }

      let filePath: null | string = null

      if (data.startsWith("[download]")) {
        const downloadString = data.replace(/^\[download\]\s*/, "")

        if (downloadString.startsWith("Unknown %")) {
          progress.value = 0
        } else {
          let match = /^(?<percentage>\d+(?:\.\d+)?)%/.exec(downloadString)
          if (match && match[1]) {
            progress.value = +match[1]
          } else {
            progress = null
          }
        }

        if (progress != null) {
          // TODO: Finish progress: https://github.com/ytdl-org/youtube-dl/blob/5208ae92fc3e2916cdccae45c6b9a516be3d5796/youtube_dl/downloader/common.py#L289-L304
          // \[download\][^0-9]*(?<percentage>\d+(?:\.\d+)?)[^0-9]+(?<size>\d+(?:\.\d+)?)(?<size_unit>\w+)(?:[^0-9]+(\d+\.\d+\w+\/s)\D+((?:\d+:?)+))?
        }

        // [download] Destination: ...
        // [download] ... has already been downloaded
        let filePathMatch =
          /^Destination:\s?(.+)|^(.+)\shas already been downloaded/.exec(
            downloadString
          )
        if (filePathMatch && filePathMatch[1]) {
          filePath = filePathMatch[1]
        }
      } else if (data.startsWith("[ffmpeg]")) {
        const ffmpegString = data.replace(/^\[ffmpeg\]\s*/, "")
        // Encountered during merging of audio and video
        let filePathMatch = /.*?\"(.*)\"/.exec(ffmpegString)
        if (filePathMatch && filePathMatch[1]) {
          filePath = filePathMatch[1]
        }

        // Encountered during format conversion
        filePathMatch = /.*?Destination:\s(.*)/.exec(ffmpegString)
        if (filePathMatch && filePathMatch[1]) {
          filePath = filePathMatch[1]
        }
      } else if (data.startsWith("[Merger]")) {
        const mergerString = data.replace(/^\[Merger\]\s*/, "")

        let filePathMatch = /^Merging formats into "(.+)"/.exec(mergerString)
        if (filePathMatch && filePathMatch[1]) {
          filePath = filePathMatch[1]
        }
      }

      // TODO: Handle le case where the format isn't available in that specific resolution

      const result = {
        progress: progress,
        progressStatus: "petting cats", //this._isPostprocessing(data.toString()),
        filepath: filePath,
      }

      dataCallback(result)
    })
  }

  /** Simply kills the child process */
  async pause(id: string) {
    const child = this.runningProcesses.get(id)
    if (child) {
      try {
        await child.kill()
      } catch (e) {
        console.warn(e)
      }
      // And now the usual handler will take care of deleting the child process
    }
  }

  /**
   *
   * @throws an error if youtube-dl is missing
   */
  async updateYoutubeDl(path: string, dataCallback: (message: string) => void) {
    const args = this.updateYoutubeDlArgs()

    return this.callYoutubeDl("update", path, args, (data) => {
      dataCallback(data)
    })
  }

  private async downloadArgs(
    item: DownloadableItem,
    {
      videoFormat,
      audioFormat,
      downloadLocation,
      outputTemplate,
      compatibilityMode,
    }: DownloadOptions
  ) {
    const args: string[] = []

    // Progress bar
    args.push("--newline")

    let audioQuality =
      item.formats.audioIndex === item.formats.audio.length - 1
        ? ""
        : `[abr<=${item.formats.audio[item.formats.audioIndex]}]`
    let videoQuality =
      item.formats.videoIndex === item.formats.video.length - 1
        ? ""
        : `[height<=${item.formats.video[item.formats.videoIndex]}]`

    // Choose format (file extension)
    if (item.isAudioChosen) {
      args.push("--format")
      let format = `best*[vcodec=none]${audioQuality}` // Pick best format by default
      if (audioFormat !== "best") {
        // Pick format with a given extension
        format = `bestaudio[ext=${audioFormat}]${audioQuality} / ${format}`
      }
      args.push(format)
    } else {
      args.push("--format")
      let format = `bestvideo*${videoQuality}+bestaudio${videoQuality}/best${videoQuality}` // Pick best format by default
      if (videoFormat !== "best") {
        // Pick format with a given extension
        format = `bestvideo*[ext=${videoFormat}]${videoQuality}+bestaudio[ext=${videoFormat}]${videoQuality}/best[ext=${videoFormat}]${videoQuality} / ${format}`
      }
      args.push(format)
    }

    args.push(`-o`, `${downloadLocation}/%(title)s [%(id)s].%(ext)s`)
    args.push("--embed-subs") // Subtitles (TODO: Does this need --write-subs)
    args.push("--embed-thumbnail") // Pretty thumbnails
    //args.push("--embed-metadata"); // More metadata (TODO: Youtube-dl doesn't understand this)

    // TODO: --limit-rate

    // https://github.com/yt-dlp/yt-dlp#post-processing-options
    // TODO: Optionally convert it with ffmpeg, if ffmpeg exists
    /*
    
    let args;
    if (item.isSubsChosen && item.subtitles.length !== 0) {
      // Download and embed subtitles
      args = ["--ffmpeg-location", this.ffmpegPath, "--all-subs", "--embed-subs", "-f", format, "-o", outputFormat];
    } else {
      args = ["--ffmpeg-location", this.ffmpegPath, "-f", format, "-o", outputFormat];
    }

    if (item.isAudioChosen) {
      args.push(...["--extract-audio", "--audio-format", audioFormat]);
    } else if (videoFormat != "default") {
      args.push(...["--recode-video", videoFormat]);
    }*/

    args.push("--")
    args.push(item.url)

    return args
  }

  private updateYoutubeDlArgs() {
    const args = ["--update"]
    return args
  }

  private async checkIfBinaryExists(name: string, args: string[]) {
    try {
      const result = await new shell.Command(name, args).execute()
      if (result.code === null || result.code === 0) {
        return result.stdout
      }
    } catch (e) {
      return null
    }
    return null
  }

  private parseDownloadableItem(
    data: string
  ): DownloadableItemBasic | DownloadableItem | null {
    try {
      let item = JSON.parse(data)
      if (item.formats) {
        // It's a typical DownloadableItem
        let video: number[] = []
        let audio: number[] = []
        item.formats.forEach(
          (format: {
            vcodec?: string
            acodec?: string
            height?: null | number
            abr?: null | number
            tbr?: null | number
          }) => {
            if (
              format.vcodec !== "none" &&
              video.indexOf(format.height ?? 0) === -1
            ) {
              video.push(format.height ?? 0)
            } else if (
              format.acodec !== "none" &&
              audio.indexOf(format.abr ?? format.tbr ?? 0) === -1
            ) {
              audio.push(format.abr ?? format.tbr ?? 0)
            }
          }
        )
        // Sort in ascending order
        video.sort((a, b) => a - b)
        audio.sort((a, b) => a - b)

        let downloadableItem: DownloadableItem = {
          // Basic
          url: item.webpage_url || item.url,
          title: item.title,
          duration: item.duration,
          uploader: item.uploader,
          // More stuff directly taken from the item
          thumbnail: item.thumbnail,
          // Stuff parsed from the item
          formats: {
            video: video,
            audio: audio,
            videoIndex: video.length - 1,
            audioIndex: audio.length - 1,
          },
          playlist: item.playlist
            ? {
              entries: item.n_entries,
              title: item.playlist_title,
              id: item.playlist_id + "",
              index: item.playlist_index,
            }
            : undefined,
          subtitles:
            item.requested_subtitles == null
              ? []
              : Object.keys(item.requested_subtitles),
          // UI state
          progress: {
            value: 0,
          },
          state: "stopped",
          isChosen: false,
          isSubsChosen: false,
          isAudioChosen: false,
        }
        return downloadableItem
        //
      } else {
        // It's a DownloadableItemBasic
        let downloadableItem: DownloadableItemBasic = {
          url: item.url,
          title: item.title,
          duration: item.duration,
          uploader: item.uploader,
        } as DownloadableItemBasic
        return downloadableItem
      }
    } catch (e) {
      console.warn("Unable to parse", e, data)
    }
    return null
  }

  /**
   * Calls youtube-dl with the given arguments and returns some info. Throws an error if youtube-dl cannot be found
   */
  private callYoutubeDl(
    id: string,
    path: string,
    args: string[],
    dataCallback: (data: any) => void
  ) {
    if (this.runningProcesses.get(id) !== undefined) {
      console.warn(`Process with id ${id} is still running`)
      return
    }

    const command = new shell.Command(path, args)
    console.info(path, args) // Always print this!

    // Data
    command.stdout.on("data", (data) => {
      // Every new playlist entry will be on its own line
      dataCallback(data)
    })
    command.stderr.on("data", (error) => {
      // TODO: Better error handling, for now this is fine
      console.error(error)
    })

    // Done
    let resolveFinishedPromise = () => { }
    let rejectFinishedPromise = (reason?: any) => { }
    const finishedPromise = new Promise<void>((resolve, reject) => {
      resolveFinishedPromise = resolve
      rejectFinishedPromise = reject
    })
    command.on("close", (data) => {
      if (data.code === null || data.code === 0) {
        resolveFinishedPromise()
      } else {
        rejectFinishedPromise("Unexpected result: " + data)
      }
    })
    command.on("error", (error) => rejectFinishedPromise(error))

    // Start the child process
    const childPromise = command.spawn().then((childProcess) => {
      this.runningProcesses.set(id, childProcess)
    })

    // And wait for everything to be done
    return finishedPromise.finally(() => {
      return childPromise.finally(() => {
        this.runningProcesses.delete(id)
      })
    })
  }

  // TODO: checkFfmpeg(path?: string)
  // TODO: downloadYoutubeDl() which tries to download it from multiple mirrors (first yt-dlc then youtube-dl)
  // https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest
  // https://api.github.com/repos/ytdl-org/youtube-dl/releases/latest
  // Take the .exe asset on Windows, and the no extension asset otherwise
  // Oh, it should also be able to ask the locally installed package manager to do so?
  // TODO: downloadFfmpeg() which tries to download it from multiple mirrors
  // https://api.github.com/repos/BtbN/youtube-dl/FFmpeg-Builds/latest with build ffmpeg-n4.4-78-g031c0cb0b4-win64-gpl-shared-4.4.zip
  // needs unzipping (???)
  // https://www.gyan.dev/ffmpeg/builds/
  // https://github.com/GyanD/codexffmpeg/releases/tag/4.4 with build ffmpeg-4.4-essentials_build.7z
  // needs un7zipping (???)
  // TODO: Better playlist support https://github.com/ytdl-org/youtube-dl#how-do-i-download-only-new-videos-from-a-playlist
  // TODO: Wait, should we automatically download dependencies on linux? Or can we just politely ask the Linux-fu-masters to do it themselves?
  // Windows Operating System detection in Rust https://doc.rust-lang.org/rust-by-example/attribute/cfg.html
}

export interface DownloadableItemBasic {
  url: string
  title: string
  /** Duration in seconds */
  duration: number
  uploader?: string
}

export interface DownloadableItem extends DownloadableItemBasic {
  filepath?: string
  thumbnail?: string
  isChosen: boolean
  state: "stopped" | "completed" | "downloading" | "queued" | "postprocessing"
  isSubsChosen: boolean
  /**
   * Only download audio.
   * @default false, both video and audio will be downloaded
   */
  isAudioChosen: boolean
  formats: {
    /** Video resolution, sorted from worst to best */
    video: number[]
    /** Audio quality, sorted from worst to best */
    audio: number[]
    videoIndex: number
    audioIndex: number
  }
  subtitles: string[]
  progress: DownloadProgress
  playlist?: {
    entries: number
    title: string
    id: string
    index: number
  }
}

type DownloadProgress = {
  value: number
  size?: string
  speed?: string
  eta?: string
}

// TODO: Rename to VideoExtension
type VideoFormat = typeof Downloader.videoFormats[number]
type AudioFormat = typeof Downloader.audioFormats[number]

type DownloadOptions = {
  videoFormat: VideoFormat
  audioFormat: AudioFormat
  downloadLocation: string
  outputTemplate: string
  compatibilityMode: boolean
}

function assertUnreachable(value: never): never {
  throw new Error("Didn't expect to get here" + value)
}
