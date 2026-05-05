import { describe, it, expect } from 'vitest'
import { isAudioMimeType, isAudioFilename } from '../media-type.js'

describe('isAudioMimeType', () => {
  it('detects audio/* MIME types', () => {
    expect(isAudioMimeType('audio/mpeg')).toBe(true)
    expect(isAudioMimeType('audio/wav')).toBe(true)
    expect(isAudioMimeType('audio/x-m4a')).toBe(true)
    expect(isAudioMimeType('audio/aac')).toBe(true)
    expect(isAudioMimeType('audio/flac')).toBe(true)
    expect(isAudioMimeType('audio/ogg')).toBe(true)
  })
  it('rejects video and other types', () => {
    expect(isAudioMimeType('video/mp4')).toBe(false)
    expect(isAudioMimeType('image/png')).toBe(false)
    expect(isAudioMimeType('application/octet-stream')).toBe(false)
    expect(isAudioMimeType('')).toBe(false)
    expect(isAudioMimeType(undefined)).toBe(false)
  })
})

describe('isAudioFilename', () => {
  it('detects audio extensions', () => {
    expect(isAudioFilename('podcast.mp3')).toBe(true)
    expect(isAudioFilename('voice.WAV')).toBe(true)
    expect(isAudioFilename('clip.m4a')).toBe(true)
    expect(isAudioFilename('test.aac')).toBe(true)
    expect(isAudioFilename('song.flac')).toBe(true)
    expect(isAudioFilename('audio.ogg')).toBe(true)
  })
  it('rejects video and other extensions', () => {
    expect(isAudioFilename('video.mp4')).toBe(false)
    expect(isAudioFilename('clip.mov')).toBe(false)
    expect(isAudioFilename('file')).toBe(false)
    expect(isAudioFilename('')).toBe(false)
  })
})
