import db from '../db.js'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BENCHMARK_DIR = join(__dirname, '..', '..', 'data', 'benchmark')

// Check if benchmark JSON files exist — if so, import them
// Otherwise, seed with sample placeholder data
function seedFromFiles() {
  const files = ['video1.json', 'video2.json', 'video3.json', 'video4.json']
  let imported = 0

  for (const file of files) {
    const path = join(BENCHMARK_DIR, file)
    if (!existsSync(path)) continue

    const data = JSON.parse(readFileSync(path, 'utf-8'))
    importVideo(data)
    imported++
  }

  return imported
}

function importVideo(data) {
  const existing = db.prepare('SELECT id FROM videos WHERE title = ?').get(data.title)
  if (existing) {
    console.log(`  Skipping "${data.title}" — already exists`)
    return
  }

  const result = db.prepare(
    'INSERT INTO videos (title, youtube_url, duration_seconds, metadata_json) VALUES (?, ?, ?, ?)'
  ).run(data.title, data.youtube_url || null, data.duration_seconds || null, JSON.stringify(data.metadata || {}))

  const videoId = result.lastInsertRowid

  if (data.raw_transcript) {
    db.prepare('INSERT INTO transcripts (video_id, type, content) VALUES (?, ?, ?)').run(videoId, 'raw', data.raw_transcript)
  }

  if (data.human_edited_transcript) {
    db.prepare('INSERT INTO transcripts (video_id, type, content) VALUES (?, ?, ?)').run(videoId, 'human_edited', data.human_edited_transcript)
  }

  console.log(`  Imported "${data.title}" (id: ${videoId})`)
}

function seedPlaceholders() {
  const placeholders = [
    {
      title: 'Benchmark Video 1 — AI Technology Overview',
      youtube_url: 'https://youtube.com/watch?v=placeholder1',
      duration_seconds: 623,
      metadata: { channel: 'TechChannel', upload_date: '2025-01-15' },
      raw_transcript: `[00:00:00] So um today we're going to talk about artificial intelligence and um you know how it's basically changing everything right
[00:00:12] In today's video I'm going to I'm going to walk you through the five biggest ways AI is changing the world right now
[00:00:28] But before we dive in make sure to hit that subscribe button if you're new here we cover the latest in tech every single week
[00:00:42] Let's start with something you probably use every single day um AI assistants whether it's ChatGPT Siri or Alexa these tools have become incredibly sophisticated
[00:00:58] I've been using ChatGPT for my research process and honestly it's it's cut my prep time in half [2.3s] But it's not just about convenience it's about capability
[00:01:18] Now let's talk about something that sounds like it's straight out of a movie um self-driving cars [3.1s] Tesla's Full Self-Driving Waymo's robotaxis they're already on the streets
[00:01:38] The technology behind autonomous vehicles is mind-blowing we're talking about neural networks processing millions of data points per second
[00:01:58] But perhaps the most impactful application of AI is in healthcare [2.5s] AI is now diagnosing diseases with accuracy that matches or exceeds human doctors
[00:02:20] Drug discovery that used to take a decade can now be um can now be accelerated to just a few years
[00:02:40] So yeah that's that's basically what I wanted to cover today make sure to like and subscribe and I'll see you in the next one`,
      human_edited_transcript: `[00:00:00] Today we're going to talk about artificial intelligence and how it's changing everything.
[00:00:12] In today's video, I'm going to walk you through the five biggest ways AI is changing the world right now.
[00:00:42] Let's start with something you probably use every single day — AI assistants. Whether it's ChatGPT, Siri, or Alexa, these tools have become incredibly sophisticated.
[00:00:58] I've been using ChatGPT for my research process and honestly, it's cut my prep time in half. [2.3s] But it's not just about convenience — it's about capability.
[00:01:18] Now let's talk about something that sounds like it's straight out of a movie — self-driving cars. [3.1s] Tesla's Full Self-Driving, Waymo's robotaxis — they're already on the streets.
[00:01:38] The technology behind autonomous vehicles is mind-blowing. We're talking about neural networks processing millions of data points per second.
[00:01:58] But perhaps the most impactful application of AI is in healthcare. [2.5s] AI is now diagnosing diseases with accuracy that matches or exceeds human doctors.
[00:02:20] Drug discovery that used to take a decade can now be accelerated to just a few years.`
    },
    {
      title: 'Benchmark Video 2 — Cooking Tutorial',
      youtube_url: 'https://youtube.com/watch?v=placeholder2',
      duration_seconds: 485,
      metadata: { channel: 'ChefChannel', upload_date: '2025-02-10' },
      raw_transcript: `[00:00:00] Hey guys welcome back to the channel um today we're making my grandmother's pasta recipe
[00:00:08] So before we get started I just want to say thank you so much for 100K subscribers that's that's insane honestly
[00:00:18] Alright so first things first you're going to need um you're going to need about 400 grams of flour [2.1s] and three large eggs
[00:00:30] Now I know some people like to use semolina flour but honestly um for this recipe all-purpose works just fine
[00:00:42] So you're going to make a well in the center of the flour and crack your eggs right into it [3.2s] and then just start slowly incorporating the flour from the edges
[00:00:58] This is this is the part where people mess up they try to go too fast and it just it becomes a mess
[00:01:10] You want to knead this for about um about ten minutes until it's smooth and elastic [2.8s] it should feel like Play-Doh basically
[00:01:28] Then wrap it in plastic and let it rest for at least 30 minutes [4.1s] this is super important don't skip this step
[00:01:42] While we wait let me tell you about today's sponsor NordVPN
[00:01:50] Alright so now we're going to roll this out you want it thin like really really thin
[00:02:02] And that's basically it guys um if you enjoyed this recipe make sure to leave a comment below and let me know how it turned out`,
      human_edited_transcript: `[00:00:00] Today we're making my grandmother's pasta recipe.
[00:00:18] First, you're going to need about 400 grams of flour [2.1s] and three large eggs.
[00:00:30] Some people like to use semolina flour, but for this recipe all-purpose works just fine.
[00:00:42] Make a well in the center of the flour and crack your eggs right into it. [3.2s] Then slowly incorporate the flour from the edges.
[00:00:58] This is the part where people mess up — they try to go too fast and it becomes a mess.
[00:01:10] Knead this for about ten minutes until it's smooth and elastic. [2.8s] It should feel like Play-Doh.
[00:01:28] Then wrap it in plastic and let it rest for at least 30 minutes. [4.1s] This is super important — don't skip this step.
[00:01:50] Now we're going to roll this out. You want it thin — really thin.`
    },
    {
      title: 'Benchmark Video 3 — Product Review',
      youtube_url: 'https://youtube.com/watch?v=placeholder3',
      duration_seconds: 540,
      metadata: { channel: 'ReviewChannel', upload_date: '2025-03-01' },
      raw_transcript: `[00:00:00] What's up everybody so um I finally got my hands on the new MacBook Pro M4 and I've been using it for about two weeks now
[00:00:12] Before we get into it smash that like button and subscribe I'm trying to hit 500K by the end of the year
[00:00:22] So right off the bat the build quality is is just incredible like Apple really knows how to make hardware
[00:00:34] The screen is um [2.4s] it's a mini-LED display and honestly it's the best laptop screen I've ever used period
[00:00:48] Now performance-wise and this is this is where it gets really interesting the M4 chip is a beast
[00:01:02] I ran some benchmarks and um the results were honestly kind of mind-blowing [3.5s] we're talking 40% faster than the M3
[00:01:18] For video editing like I edit all my videos on this thing now and the timeline is just butter smooth
[00:01:32] Battery life [2.2s] they claim 18 hours and in my testing I got about 15 to 16 hours of real-world usage which is which is pretty close
[00:01:48] Now the downsides um the price is still ridiculous you're looking at $2500 for the base model
[00:02:02] And like I've said before the notch is still there and it's still annoying honestly
[00:02:14] But overall I think this is I think this is the best laptop you can buy right now if you're in the Apple ecosystem
[00:02:28] Let me know in the comments what you think are you going to upgrade or are you waiting for the M5`,
      human_edited_transcript: `[00:00:00] I finally got my hands on the new MacBook Pro M4 and I've been using it for about two weeks now.
[00:00:22] Right off the bat, the build quality is incredible. Apple really knows how to make hardware.
[00:00:34] The screen is [2.4s] a mini-LED display, and it's the best laptop screen I've ever used.
[00:00:48] Performance-wise, this is where it gets really interesting — the M4 chip is a beast.
[00:01:02] I ran some benchmarks and the results were mind-blowing. [3.5s] We're talking 40% faster than the M3.
[00:01:18] For video editing — I edit all my videos on this thing now — the timeline is butter smooth.
[00:01:32] Battery life: [2.2s] they claim 18 hours, and in my testing I got about 15 to 16 hours of real-world usage, which is pretty close.
[00:01:48] The downsides — the price is still ridiculous. You're looking at $2500 for the base model.
[00:02:02] The notch is still there and it's still annoying.
[00:02:14] But overall, I think this is the best laptop you can buy right now if you're in the Apple ecosystem.`
    },
    {
      title: 'Benchmark Video 4 — History Documentary',
      youtube_url: 'https://youtube.com/watch?v=placeholder4',
      duration_seconds: 720,
      metadata: { channel: 'HistoryChannel', upload_date: '2025-03-05' },
      raw_transcript: `[00:00:00] The year was 1969 and um humanity was about to take its most ambitious step yet
[00:00:12] Now I want to I want to give you the full context here because most people don't realize how close we came to failure
[00:00:24] The Apollo 11 mission wasn't just about getting to the moon it was about it was about proving that we could [3.8s] that we could push beyond what anyone thought was possible
[00:00:42] So Neil Armstrong Buzz Aldrin and Michael Collins they launched on July 16th from Kennedy Space Center
[00:00:56] The Saturn V rocket [2.5s] this thing was enormous 363 feet tall generating 7.5 million pounds of thrust
[00:01:14] Now here's something most people don't know um during the descent to the lunar surface the onboard computer started throwing error codes
[00:01:28] The 1202 alarm [2.9s] basically the computer was saying I have too many things to do and I can't keep up
[00:01:42] Armstrong had to basically he had to take manual control and fly the thing himself looking out the window for a safe landing spot
[00:01:58] They landed with about 25 seconds of fuel remaining [4.2s] twenty-five seconds that's it
[00:02:14] If you think about it like if you really think about it the margin between success and catastrophe was almost nothing
[00:02:28] And then Armstrong stepped onto the surface and said those famous words [3.1s] one small step for man one giant leap for mankind
[00:02:48] Now there's actually a debate about whether he said "for a man" or "for man" but um that's a topic for another video
[00:03:02] The point is this moment changed everything it changed how we see ourselves as a species
[00:03:16] Make sure to check out my documentary series on the full Apollo program link in the description`,
      human_edited_transcript: `[00:00:00] The year was 1969, and humanity was about to take its most ambitious step yet.
[00:00:12] I want to give you the full context here, because most people don't realize how close we came to failure.
[00:00:24] The Apollo 11 mission wasn't just about getting to the moon — it was about proving that we could [3.8s] push beyond what anyone thought was possible.
[00:00:42] Neil Armstrong, Buzz Aldrin, and Michael Collins launched on July 16th from Kennedy Space Center.
[00:00:56] The Saturn V rocket — [2.5s] this thing was enormous. 363 feet tall, generating 7.5 million pounds of thrust.
[00:01:14] Here's something most people don't know: during the descent to the lunar surface, the onboard computer started throwing error codes.
[00:01:28] The 1202 alarm. [2.9s] The computer was saying "I have too many things to do and I can't keep up."
[00:01:42] Armstrong had to take manual control and fly the thing himself, looking out the window for a safe landing spot.
[00:01:58] They landed with about 25 seconds of fuel remaining. [4.2s] Twenty-five seconds. That's it.
[00:02:14] If you think about it, the margin between success and catastrophe was almost nothing.
[00:02:28] And then Armstrong stepped onto the surface and said those famous words. [3.1s] "One small step for man, one giant leap for mankind."
[00:02:48] There's actually a debate about whether he said "for a man" or "for man," but that's a topic for another video.
[00:03:02] This moment changed everything — it changed how we see ourselves as a species.`
    }
  ]

  for (const v of placeholders) {
    const result = db.prepare(
      'INSERT INTO videos (title, youtube_url, duration_seconds, metadata_json) VALUES (?, ?, ?, ?)'
    ).run(v.title, v.youtube_url, v.duration_seconds, JSON.stringify(v.metadata))
    const videoId = result.lastInsertRowid
    db.prepare('INSERT INTO transcripts (video_id, type, content) VALUES (?, ?, ?)').run(videoId, 'raw', v.raw_transcript)
    db.prepare('INSERT INTO transcripts (video_id, type, content) VALUES (?, ?, ?)').run(videoId, 'human_edited', v.human_edited_transcript)
    console.log(`  Seeded "${v.title}" (id: ${videoId})`)
  }
}

// Main
console.log('Importing benchmark data...')

const existingCount = db.prepare('SELECT COUNT(*) AS count FROM videos').get().count
if (existingCount > 0) {
  console.log(`Database already has ${existingCount} videos. Skipping seed.`)
  console.log('To re-seed, delete data/eval.db and run again.')
  process.exit(0)
}

const imported = seedFromFiles()
if (imported === 0) {
  console.log('No benchmark JSON files found in data/benchmark/. Using placeholder data...')
  seedPlaceholders()
}

const finalCount = db.prepare('SELECT COUNT(*) AS count FROM videos').get().count
console.log(`Done. ${finalCount} benchmark videos in database.`)
