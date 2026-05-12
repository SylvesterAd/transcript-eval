// Audio emission for A-roll in XMEML output.
//
// Background: Premiere/DaVinci import XMEML with video clipitems but no
// declared audio characteristics fell back to a "level 0" / muted default.
// The fix is to mirror WyattBlue/auto-editor's `premiereWriteAudio` pattern
// (the proven-working FCP7 audio emitter) — declare audio characteristics
// on the <file>, emit a sequence <audio> with <numOutputChannels> + <format>,
// and per-track Premiere stereo attributes so the importer interprets the
// in/out values as video frames rather than as audio samples.
//
// Scope: ONLY the A-roll gets audio. B-roll stays silent (visual overlay).
import { describe, it, expect } from 'vitest'
import { generateXmeml } from '../xmeml-generator.js'

const baseInput = {
  sequenceName: 'AudioSeq',
  placements: [],
  frameRate: 50,
  sequenceSize: { w: 1920, h: 1080 },
}

// The sequence-level <audio> is always the LAST <audio> in the document;
// each A-roll <file><media> also has its own inner <audio> for stereo
// characteristics. lastIndexOf isolates the outer one cleanly.
function sliceOuterAudio(xml) {
  const start = xml.lastIndexOf('<audio>')
  if (start < 0) return ''
  const closeTag = '</audio>'
  const end = xml.indexOf(closeTag, start)
  if (end < 0) return ''
  return xml.slice(start, end + closeTag.length)
}

describe('generateXmeml — A-roll audio (auto-editor-compatible structure)', () => {
  it('emits an <audio> sibling to <video> in <media> when arollSegments present', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 10, sourceFrameRate: 30, sourceDurationSeconds: 10 }],
    })
    expect(xml).toMatch(/<\/video>\s*<audio>/)
    expect(xml).toMatch(/<\/audio>\s*<\/media>/)
  })

  it('does NOT emit <media><audio> when no A-roll is present (B-roll stays silent)', () => {
    const xml = generateXmeml({
      ...baseInput,
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '1', filename: '001_pexels_1.mp4',
          timelineStart: 0, timelineDuration: 2, sourceFrameRate: 30 },
      ],
    })
    expect(xml).not.toMatch(/<\/video>\s*<audio>/)
  })

  it('does NOT emit <media><audio> when both A-roll and B-roll are absent', () => {
    const xml = generateXmeml({ ...baseInput })
    expect(xml).not.toMatch(/<audio>/)
  })

  it('emits stereo audio characteristics inside the A-roll <file> block', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    // <file><media> has <video> then <audio> sibling with stereo characteristics.
    expect(xml).toMatch(/<file id="file-aroll">[\s\S]*?<media>[\s\S]*?<\/video>\s*<audio>\s*<samplecharacteristics>\s*<depth>16<\/depth>\s*<samplerate>48000<\/samplerate>\s*<\/samplecharacteristics>\s*<channelcount>2<\/channelcount>\s*<\/audio>\s*<\/media>/)
  })

  it('opens the sequence <audio> with <numOutputChannels>2</numOutputChannels> + <format>', () => {
    // Auto-editor reference: audio.add elem("numOutputChannels", "2"); then
    // a <format><samplecharacteristics> declaring depth and samplerate. Without
    // these, Premiere has no declared sequence audio rate and reinterprets
    // clipitem timings.
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    const audioBlock = sliceOuterAudio(xml)
    expect(audioBlock).toMatch(/^<audio>\s*<numOutputChannels>2<\/numOutputChannels>\s*<format>\s*<samplecharacteristics>\s*<depth>16<\/depth>\s*<samplerate>48000<\/samplerate>\s*<\/samplecharacteristics>\s*<\/format>/)
  })

  it('emits two audio tracks (A1 + A2) with Premiere stereo attributes', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 10, sourceFrameRate: 30, sourceDurationSeconds: 10 }],
    })
    const audioBlock = sliceOuterAudio(xml)
    const tracks = audioBlock.match(/<track\b[\s\S]*?<\/track>/g) || []
    expect(tracks.length).toBe(2)
    // A1 = exploded index 0 of 2 stereo channels
    expect(tracks[0]).toMatch(/^<track\s+currentExplodedTrackIndex="0"\s+totalExplodedTrackCount="2"\s+premiereTrackType="Stereo">/)
    // A2 = exploded index 1
    expect(tracks[1]).toMatch(/^<track\s+currentExplodedTrackIndex="1"\s+totalExplodedTrackCount="2"\s+premiereTrackType="Stereo">/)
  })

  it('each track declares an outputchannelindex (1 for A1, 2 for A2) before clipitems', () => {
    // Without outputchannelindex, Premiere does not route the stereo
    // pair to A1+A2 outputs and the imported timeline mis-assigns channels.
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    const audioBlock = sliceOuterAudio(xml)
    const tracks = audioBlock.match(/<track\b[\s\S]*?<\/track>/g) || []
    expect(tracks[0]).toMatch(/<track\b[^>]*>\s*<outputchannelindex>1<\/outputchannelindex>/)
    expect(tracks[1]).toMatch(/<track\b[^>]*>\s*<outputchannelindex>2<\/outputchannelindex>/)
  })

  it('each audio clipitem has premiereChannelType="stereo" attribute', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    const audioBlock = sliceOuterAudio(xml)
    const clipitems = audioBlock.match(/<clipitem\b[^>]*>/g) || []
    expect(clipitems.length).toBe(2)
    for (const open of clipitems) {
      expect(open).toMatch(/premiereChannelType="stereo"/)
    }
  })

  it('audio clipitems do NOT emit <duration>, <pproTicks*>, or <filter> (auto-editor parity)', () => {
    // Premiere reinterprets these on audio context: <duration> in frame
    // count becomes wrongly read as samples; pproTicks shouldn't be on
    // audio; the audiolevels filter is unnecessary once <format> is declared.
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    const audioBlock = sliceOuterAudio(xml)
    const clipitems = audioBlock.match(/<clipitem\b[\s\S]*?<\/clipitem>/g) || []
    expect(clipitems.length).toBeGreaterThan(0)
    for (const clip of clipitems) {
      expect(clip).not.toMatch(/<duration>/)
      expect(clip).not.toMatch(/<pproTicksIn>/)
      expect(clip).not.toMatch(/<pproTicksOut>/)
      expect(clip).not.toMatch(/<filter>/)
      expect(clip).not.toMatch(/audiolevels/)
    }
  })

  it('emits audio clipitem elements in auto-editor order (name, enabled, start, end, in, out, file, sourcetrack, labels)', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    const audioBlock = sliceOuterAudio(xml)
    const clip = (audioBlock.match(/<clipitem\b[\s\S]*?<\/clipitem>/) || [])[0] || ''
    expect(clip).toMatch(
      /<clipitem[^>]*>\s*<name>[\s\S]*?<\/name>\s*<enabled>TRUE<\/enabled>\s*<start>[^<]*<\/start>\s*<end>[^<]*<\/end>\s*<in>[^<]*<\/in>\s*<out>[^<]*<\/out>\s*<file [^>]*\/>\s*<sourcetrack>[\s\S]*?<\/sourcetrack>\s*<labels>[\s\S]*?<\/labels>/
    )
  })

  it('emits <labels><label2>Iris</label2></labels> per auto-editor convention', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    const audioBlock = sliceOuterAudio(xml)
    const clipitems = audioBlock.match(/<clipitem\b[\s\S]*?<\/clipitem>/g) || []
    for (const clip of clipitems) {
      expect(clip).toMatch(/<labels>\s*<label2>Iris<\/label2>\s*<\/labels>/)
    }
  })

  it('audio clipitem timing mirrors the V1 video clipitem (start/end/in/out)', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{
        filename: 'aroll.mov',
        start: 10, end: 20,
        sourceFrameRate: 30, sourceDurationSeconds: 30,
      }],
    })
    const audioBlock = sliceOuterAudio(xml)
    const firstClip = (audioBlock.match(/<clipitem\b[\s\S]*?<\/clipitem>/) || [])[0] || ''
    expect(firstClip).toMatch(/<start>500<\/start>/)
    expect(firstClip).toMatch(/<end>1000<\/end>/)
    expect(firstClip).toMatch(/<in>300<\/in>/)
    expect(firstClip).toMatch(/<out>600<\/out>/)
  })

  it('emits one audio clipitem per A-roll segment per channel', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [
        { filename: 'aroll.mov', start: 0,  end: 10, sourceFrameRate: 30, sourceDurationSeconds: 30 },
        { filename: 'aroll.mov', start: 15, end: 30, sourceFrameRate: 30, sourceDurationSeconds: 30 },
      ],
    })
    const audioBlock = sliceOuterAudio(xml)
    const clipCount = (audioBlock.match(/<clipitem\b/g) || []).length
    expect(clipCount).toBe(4)  // 2 segments × 2 channels
  })

  it('audio clipitem on A1 declares sourcetrack channel 1; on A2 declares channel 2', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    const audioBlock = sliceOuterAudio(xml)
    const tracks = audioBlock.match(/<track\b[\s\S]*?<\/track>/g) || []
    expect(tracks[0]).toMatch(/<sourcetrack>\s*<mediatype>audio<\/mediatype>\s*<trackindex>1<\/trackindex>\s*<\/sourcetrack>/)
    expect(tracks[1]).toMatch(/<sourcetrack>\s*<mediatype>audio<\/mediatype>\s*<trackindex>2<\/trackindex>\s*<\/sourcetrack>/)
  })

  it('audio clipitems reference the same <file id="file-aroll"/> as the video', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    const audioBlock = sliceOuterAudio(xml)
    const clipitems = audioBlock.match(/<clipitem\b[\s\S]*?<\/clipitem>/g) || []
    for (const clip of clipitems) {
      expect(clip).toMatch(/<file id="file-aroll"\/>/)
    }
  })

  it('audio clipitems link to their V1 video twin via <link>', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    const videoClipId = 'clip-audioseq-aroll-1'
    const audioBlock = sliceOuterAudio(xml)
    const clipitems = audioBlock.match(/<clipitem\b[\s\S]*?<\/clipitem>/g) || []
    for (const clip of clipitems) {
      expect(clip).toMatch(new RegExp(
        `<link>\\s*<linkclipref>${videoClipId}</linkclipref>\\s*<mediatype>video</mediatype>`
      ))
    }
  })

  it('legacy aroll prop (no segments) also emits audio in the same structure', () => {
    const xml = generateXmeml({
      ...baseInput,
      aroll: { filename: 'legacy.mov', frameRate: 30, sourceDurationSeconds: 60 },
    })
    expect(xml).toMatch(/<\/video>\s*<audio>/)
    const audioBlock = sliceOuterAudio(xml)
    expect(audioBlock).toMatch(/<numOutputChannels>2<\/numOutputChannels>/)
    const tracks = audioBlock.match(/<track\b[\s\S]*?<\/track>/g) || []
    expect(tracks.length).toBe(2)
    const clipCount = (audioBlock.match(/<clipitem\b/g) || []).length
    expect(clipCount).toBe(2)
  })

  it('audio clipitem IDs are derived from the V1 video clip ID with -a1/-a2 suffix', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [
        { filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 30 },
        { filename: 'aroll.mov', start: 10, end: 15, sourceFrameRate: 30, sourceDurationSeconds: 30 },
      ],
    })
    expect(xml).toContain('<clipitem id="clip-audioseq-aroll-1-a1"')
    expect(xml).toContain('<clipitem id="clip-audioseq-aroll-1-a2"')
    expect(xml).toContain('<clipitem id="clip-audioseq-aroll-2-a1"')
    expect(xml).toContain('<clipitem id="clip-audioseq-aroll-2-a2"')
  })
})
