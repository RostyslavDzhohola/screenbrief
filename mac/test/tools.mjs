// ffmpeg and ffprobe for the tests, found the way the tool itself finds them
// (SCREENBRIEF_FFMPEG / SCREENBRIEF_FFPROBE, then Homebrew on Apple silicon or Intel).
import { tools } from '../src/config.mjs';

export const FFMPEG = tools().ffmpeg;
export const FFPROBE = tools().ffprobe;
