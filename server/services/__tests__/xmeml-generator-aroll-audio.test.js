// Audio emission for A-roll in XMEML output.
//
// Background: Premiere/DaVinci import XMEML with video clipitems but no
// declared audio characteristics or audiolevels filter, and they fall
// back to a "level 0" / muted default — the user sees A-roll on the
// timeline at volume 0. This file pins the fix:
//   - The A-roll <file> declares stereo audio characteristics.
//   - <media> has an <audio> sibling to <video> with two tracks (A1, A2).
//   - Each audio clipitem mirrors the video clipitem's timing AND carries
//     a unity-gain <filter><effect type="audiolevels"> so Premiere
//     applies 0dB instead of muting.
//   - Audio clipitems are linked to their V1 twin via <link>, so trims
//     stay in sync.
//
// Scope: ONLY the A-roll gets audio. B-roll stays silent (it's a visual
// overlay over A-roll audio).
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
// characteristics. lastIndexOf isolates the outer one cleanly so we can
// grep clipitems / tracks inside it without colliding with inner tags.
function sliceOuterAudio(xml) {
  const start = xml.lastIndexOf('<audio>')
  if (start < 0) return ''
  const closeTag = '</audio>'
  const end = xml.indexOf(closeTag, start)
  if (end < 0) return ''
  return xml.slice(start, end + closeTag.length)
}

describe('generateXmeml — A-roll audio (fix for volume-0 import bug)', () => {
  it('emits an <audio> sibling to <video> in <media> when arollSegments present', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 10, sourceFrameRate: 30, sourceDurationSeconds: 10 }],
    })
    // <video> closes BEFORE <audio> opens, both nested inside <media>.
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
    // No <audio> block at all when only B-roll exists. The B-roll is a
    // silent visual overlay; user keeps A-roll's audio underneath.
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
    // <file> for A-roll declares <media><video>...</video><audio>...</audio></media>.
    // Channel count 2 (stereo) — most camera/recorder A-roll source is stereo;
    // a mono source on a stereo declaration mirrors channel 1 to both, which
    // is the right behavior for talking-head footage.
    expect(xml).toMatch(/<file id="file-aroll">[\s\S]*?<media>[\s\S]*?<\/video>\s*<audio>\s*<samplecharacteristics>\s*<depth>16<\/depth>\s*<samplerate>48000<\/samplerate>\s*<\/samplecharacteristics>\s*<channelcount>2<\/channelcount>\s*<\/audio>\s*<\/media>/)
  })

  it('emits two audio tracks (A1 + A2) — one per stereo channel', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 10, sourceFrameRate: 30, sourceDurationSeconds: 10 }],
    })
    // The <audio> sequence block contains exactly two <track>s.
    // Anchor to the sequence-level <audio> (the LAST <audio> in the doc);
    // a different inner <audio> lives inside each <file><media> for characteristics.
    const audioBlock = sliceOuterAudio(xml)
    const trackCount = (audioBlock.match(/<track>/g) || []).length
    expect(trackCount).toBe(2)
  })

  it('emits one audio clipitem per A-roll segment per channel', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [
        { filename: 'aroll.mov', start: 0,  end: 10, sourceFrameRate: 30, sourceDurationSeconds: 30 },
        { filename: 'aroll.mov', start: 15, end: 30, sourceFrameRate: 30, sourceDurationSeconds: 30 },
      ],
    })
    // Anchor to the sequence-level <audio> (the LAST <audio> in the doc);
    // a different inner <audio> lives inside each <file><media> for characteristics.
    const audioBlock = sliceOuterAudio(xml)
    // 2 segments × 2 channels = 4 audio clipitems.
    const clipCount = (audioBlock.match(/<clipitem id=/g) || []).length
    expect(clipCount).toBe(4)
  })

  it('audio clipitem timing mirrors the V1 video clipitem (start/end/in/out)', () => {
    // Source A-roll is 30s at 30fps. Single segment 10s-20s.
    // Video timing: <start>=10*50=500, <end>=20*50=1000, <in>=10*30=300, <out>=20*30=600.
    // Audio twin must match these numbers — without it, Premiere drifts the
    // audio off the video.
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{
        filename: 'aroll.mov',
        start: 10, end: 20,
        sourceFrameRate: 30, sourceDurationSeconds: 30,
      }],
    })
    // Anchor to the sequence-level <audio> (the LAST <audio> in the doc);
    // a different inner <audio> lives inside each <file><media> for characteristics.
    const audioBlock = sliceOuterAudio(xml)
    // Each track's clipitem has the same timing.
    const a1ClipMatch = audioBlock.match(/<track>[\s\S]*?<\/track>/)
    expect(a1ClipMatch).toBeTruthy()
    const a1Clip = a1ClipMatch[0]
    expect(a1Clip).toMatch(/<start>500<\/start>/)
    expect(a1Clip).toMatch(/<end>1000<\/end>/)
    expect(a1Clip).toMatch(/<in>300<\/in>/)
    expect(a1Clip).toMatch(/<out>600<\/out>/)
  })

  it('emits unity-gain audiolevels filter on every audio clipitem (THE bug fix)', () => {
    // Without <filter><effect><effectid>audiolevels</effectid>...<value>1</value>,
    // Premiere defaults the imported audio level to 0 (muted) — exactly the
    // user-reported volume-0 symptom. <value>1</value> = unity gain (0dB).
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    // Anchor to the sequence-level <audio> (the LAST <audio> in the doc);
    // a different inner <audio> lives inside each <file><media> for characteristics.
    const audioBlock = sliceOuterAudio(xml)
    const clipitems = audioBlock.match(/<clipitem id=[\s\S]*?<\/clipitem>/g) || []
    expect(clipitems.length).toBe(2)  // A1 + A2
    for (const clip of clipitems) {
      // Filter must be present and set to unity gain.
      expect(clip).toMatch(/<filter>[\s\S]*?<effect>[\s\S]*?<effectid>audiolevels<\/effectid>[\s\S]*?<value>1<\/value>[\s\S]*?<\/effect>[\s\S]*?<\/filter>/)
    }
  })

  it('audio clipitem on A1 declares sourcetrack channel 1; on A2 declares channel 2', () => {
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    // Anchor to the sequence-level <audio> (the LAST <audio> in the doc);
    // a different inner <audio> lives inside each <file><media> for characteristics.
    const audioBlock = sliceOuterAudio(xml)
    const tracks = audioBlock.match(/<track>[\s\S]*?<\/track>/g) || []
    expect(tracks.length).toBe(2)
    // A1 = channel 1
    expect(tracks[0]).toMatch(/<sourcetrack>\s*<mediatype>audio<\/mediatype>\s*<trackindex>1<\/trackindex>\s*<\/sourcetrack>/)
    // A2 = channel 2
    expect(tracks[1]).toMatch(/<sourcetrack>\s*<mediatype>audio<\/mediatype>\s*<trackindex>2<\/trackindex>\s*<\/sourcetrack>/)
  })

  it('audio clipitems reference the same <file id="file-aroll"/> as the video', () => {
    // The <file> body lives on the V1 video clipitem (i===0); audio
    // clipitems use the self-closing reference form. Without this,
    // we would emit duplicate <file id="file-aroll"> blocks → invalid XML
    // / DaVinci "Item already exists" error.
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    // Anchor to the sequence-level <audio> (the LAST <audio> in the doc);
    // a different inner <audio> lives inside each <file><media> for characteristics.
    const audioBlock = sliceOuterAudio(xml)
    const clipitems = audioBlock.match(/<clipitem id=[\s\S]*?<\/clipitem>/g) || []
    for (const clip of clipitems) {
      expect(clip).toMatch(/<file id="file-aroll"\/>/)
    }
  })

  it('audio clipitems link to their V1 video twin via <link>', () => {
    // <link> blocks make Premiere treat V1 + A1 + A2 as a single linked
    // clip — trimming the video also trims audio. Without it the user can
    // accidentally desync.
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [{ filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 5 }],
    })
    // V1 video clipitem ID for segment 1.
    const videoClipId = 'clip-audioseq-aroll-1'
    // Anchor to the sequence-level <audio> (the LAST <audio> in the doc);
    // a different inner <audio> lives inside each <file><media> for characteristics.
    const audioBlock = sliceOuterAudio(xml)
    const clipitems = audioBlock.match(/<clipitem id=[\s\S]*?<\/clipitem>/g) || []
    for (const clip of clipitems) {
      // Each audio clipitem includes a <link> referencing the V1 video twin.
      expect(clip).toMatch(new RegExp(
        `<link>\\s*<linkclipref>${videoClipId}</linkclipref>\\s*<mediatype>video</mediatype>`
      ))
    }
  })

  it('legacy aroll prop (no segments) also emits audio', () => {
    // Backwards-compat: the route still falls back to the legacy single-clip
    // aroll path when there are no editor cuts. Audio must work there too.
    const xml = generateXmeml({
      ...baseInput,
      aroll: { filename: 'legacy.mov', frameRate: 30, sourceDurationSeconds: 60 },
    })
    expect(xml).toMatch(/<\/video>\s*<audio>/)
    // Anchor to the sequence-level <audio> (the LAST <audio> in the doc);
    // a different inner <audio> lives inside each <file><media> for characteristics.
    const audioBlock = sliceOuterAudio(xml)
    // Two tracks (A1 + A2), one clipitem each.
    const clipCount = (audioBlock.match(/<clipitem id=/g) || []).length
    expect(clipCount).toBe(2)
    // Both clipitems carry unity-gain filter.
    expect(audioBlock.match(/<value>1<\/value>/g)?.length).toBe(2)
  })

  it('audio clipitem IDs are derived from the V1 video clip ID with -a1/-a2 suffix', () => {
    // Stable, debuggable IDs: V1 = clip-audioseq-aroll-1, audio twins are
    // clip-audioseq-aroll-1-a1 and clip-audioseq-aroll-1-a2. Makes <link>
    // wiring obvious by inspection.
    const xml = generateXmeml({
      ...baseInput,
      arollSegments: [
        { filename: 'aroll.mov', start: 0, end: 5, sourceFrameRate: 30, sourceDurationSeconds: 30 },
        { filename: 'aroll.mov', start: 10, end: 15, sourceFrameRate: 30, sourceDurationSeconds: 30 },
      ],
    })
    expect(xml).toContain('<clipitem id="clip-audioseq-aroll-1-a1">')
    expect(xml).toContain('<clipitem id="clip-audioseq-aroll-1-a2">')
    expect(xml).toContain('<clipitem id="clip-audioseq-aroll-2-a1">')
    expect(xml).toContain('<clipitem id="clip-audioseq-aroll-2-a2">')
  })
})
