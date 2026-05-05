import { describe, it, expect } from 'vitest'
import { isAudioMimeType, isAudioFilename, isAudioFile } from '../media-type.js'

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
    expect(isAudioFilename('voice.opus')).toBe(true)
    expect(isAudioFilename('podcast.wma')).toBe(true)
  })
  it('rejects video and other extensions', () => {
    expect(isAudioFilename('video.mp4')).toBe(false)
    expect(isAudioFilename('clip.mov')).toBe(false)
    expect(isAudioFilename('file')).toBe(false)
    expect(isAudioFilename('')).toBe(false)
  })
})

describe('isAudioFile', () => {
  it('detects audio via mimetype', () => {
    expect(isAudioFile({ mimetype: 'audio/mpeg', originalname: 'voice.bin' })).toBe(true)
  })
  it('detects audio via extension when mimetype is octet-stream', () => {
    expect(isAudioFile({ mimetype: 'application/octet-stream', originalname: 'voice.opus' })).toBe(true)
  })
  it('detects audio via extension when mimetype is missing', () => {
    expect(isAudioFile({ originalname: 'clip.m4a' })).toBe(true)
  })
  it('rejects video files with non-audio extension', () => {
    expect(isAudioFile({ mimetype: 'video/mp4', originalname: 'clip.mp4' })).toBe(false)
  })
  it('handles null and missing fields', () => {
    expect(isAudioFile(null)).toBe(false)
    expect(isAudioFile(undefined)).toBe(false)
    expect(isAudioFile({})).toBe(false)
  })
})
