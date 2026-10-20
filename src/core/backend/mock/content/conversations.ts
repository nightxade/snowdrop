/**
 * Conversation scripts for the demo world. All text is original.
 *
 * Line syntax: markdown as typed in the composer, plus two tokens —
 * `{@}` mentions a random other member, `{@me}` mentions the local user.
 */

export type ImageKind = 'peaks' | 'sunset' | 'bars' | 'palette' | 'garden';

export interface FileSeed {
  fileName: string;
  contentType: string;
  size: number;
}

export interface ScriptedMessage {
  daysAgo: number;
  hour: number;
  minute: number;
  author: string;
  text?: string;
  image?: ImageKind | ImageKind[];
  file?: FileSeed;
  /** Reply to the scripted message this many entries earlier in the list. */
  replyTo?: number;
  reactions?: [emoji: string, author: string][];
  edited?: boolean;
  deleted?: boolean;
  /** System line instead of a normal message. */
  system?: string;
}

export interface ConversationSeed {
  key: string;
  kind: 'group' | 'direct';
  /** Groups only; DMs are titled after the peer. */
  title?: string;
  description?: string;
  /** Person keys, excluding the local user (always a member). */
  members: string[];
  admins?: string[];
  /** Filler pool for generated bursts. */
  lines: string[];
  scripted?: ScriptedMessage[];
  /** Relative message volume, ~1 = a couple of bursts a day. */
  activity: number;
  /** Leave this many of the newest messages unread. */
  unread?: number;
  expireTimerSec?: number;
  muted?: boolean;
  pinned?: boolean;
  /** Candidate for the liveliness simulator. */
  lively?: boolean;
  /**
   * Demo data for "archived on the phone seeds archived in Snowdrop, once,
   * only with no local state yet" (SyncService.initialSync): a real signal-cli
   * adapter reads this from a history chat frame's `archived` (see
   * history/directory.ts); the mock just sets it directly.
   */
  historyArchived?: boolean;
}

export interface SpaceSeed {
  name: string;
  emoji: string;
  categories: { name: string; conversations: string[] }[];
}

export const CASUAL_LINES: readonly string[] = [
  'haha yes',
  'ok that is *very* good',
  'on my way',
  'running ~5 min late, sorry!',
  'sounds perfect',
  'wait really?',
  'I was just thinking the same thing',
  'love that',
  'can we do tomorrow instead?',
  'noted 👍',
  'lol',
  'agreed',
  'omg',
  'thank you!!',
  'hmm, let me check',
  'yes please',
  'I owe you one',
  'brb',
  'that tracks',
  'no rush at all',
  'good call',
  'honestly iconic',
  'ha, classic',
  'fair enough',
];

export const CONVERSATIONS: readonly ConversationSeed[] = [
  // ─── Work ─────────────────────────────────────────────────────────────
  {
    key: 'orchard-eng',
    kind: 'group',
    title: 'Orchard · Engineering',
    description: 'Day-to-day engineering chat for the Orchard app. Incidents go to #release-train.',
    members: ['ines', 'tomasz', 'oren', 'dev', 'mireille', 'priya'],
    admins: ['ines', 'me'],
    activity: 1.4,
    unread: 4,
    lines: [
      'PR is up for the sync refactor, would love a second pair of eyes',
      'CI is green again 🎉',
      'who owns the `retry_budget` config these days?',
      'I think the flake is in the websocket reconnect test, not the code',
      'pairing on this after lunch if anyone wants in',
      'merged! thanks for the quick review',
      'the migration ran in 42s on staging, *much* better than last time',
      'can we please stop naming branches `fix-2`',
      'profiling shows most of the time is in JSON parsing, not the network',
      '{@} did you see the error spike around 3pm?',
      'I left some nits, nothing blocking',
      'bumping the lockfile, brace yourselves',
      'rolled back, looking into it',
      'turns out it was a timezone bug. It is *always* a timezone bug.',
      'docs updated in the wiki',
      '{@me} could you sanity-check the rollout plan when you get a sec?',
      'the new index cut p95 from 380ms to 40ms',
      'feature flag is at 10%, no alarms so far',
      'reminder: code freeze starts Thursday at noon',
      'I am going to write an ADR for this so we stop relitigating it',
    ],
    scripted: [
      { daysAgo: 6, hour: 9, minute: 2, author: 'ines', system: 'Ines Okafor created the group.' },
      {
        daysAgo: 6,
        hour: 9,
        minute: 3,
        author: 'ines',
        system:
          'Ines Okafor added Tomasz Wren, Oren Blackwood, Dev Ashcombe, Mireille Tanaka, Priya Castellan and you.',
      },
      {
        daysAgo: 2,
        hour: 11,
        minute: 14,
        author: 'oren',
        text: 'Found the culprit for the duplicate notifications. We subscribe twice when the socket reconnects:\n```ts\nsocket.on("open", () => {\n  subscribe(channel);   // runs on every reconnect\n});\nsubscribe(channel);     // …and once more at boot\n```\nFix is to make `subscribe` idempotent per channel.',
        reactions: [
          ['🎯', 'ines'],
          ['🙏', 'tomasz'],
          ['🎯', 'dev'],
        ],
      },
      {
        daysAgo: 2,
        hour: 11,
        minute: 16,
        author: 'ines',
        text: 'nice catch. Can you add a regression test that reconnects **twice**?',
        replyTo: 1,
      },
      { daysAgo: 2, hour: 11, minute: 17, author: 'oren', text: 'already on it' },
      {
        daysAgo: 1,
        hour: 15,
        minute: 40,
        author: 'mireille',
        text: 'Quick summary from the planning session so nobody has to read the doc:\n\n**Next two weeks**\n• offline drafts (Juniper + Tomasz)\n• search indexing (Ines)\n• *stretch:* keyboard shortcuts overhaul\n\n**Not doing**\n• custom emoji upload — needs a storage story first\n\nShout if anything looks wrong. ~~Launch party~~ Retro is Friday.',
        reactions: [
          ['👍', 'me'],
          ['👍', 'priya'],
          ['💯', 'dev'],
        ],
        edited: true,
      },
      {
        daysAgo: 1,
        hour: 15,
        minute: 44,
        author: 'tomasz',
        text: 'offline drafts 🙌 finally',
        replyTo: 1,
      },
      {
        daysAgo: 1,
        hour: 16,
        minute: 5,
        author: 'priya',
        text: 'mockups for the drafts indicator',
        image: 'palette',
      },
      {
        daysAgo: 0,
        hour: 8,
        minute: 50,
        author: 'dev',
        text: 'accidentally pasted a token here, deleting',
        deleted: true,
      },
    ],
  },
  {
    key: 'orchard-design',
    kind: 'group',
    title: 'Orchard · Design Crit',
    description: 'Show work early. Be kind, be specific.',
    members: ['priya', 'mireille', 'ines', 'samir'],
    admins: ['priya'],
    activity: 0.7,
    lines: [
      'I think the empty state needs a clearer next action',
      'what if the avatar sat *inside* the card instead?',
      'love the new spacing scale, it breathes',
      'contrast on the muted text is a bit low in light mode',
      'can we try this with real content? lorem ipsum hides problems',
      'the icon feels heavier than the text next to it',
      'v2 is up, addressed most comments',
      'this reads much calmer now',
      '{@} what was the reference you mentioned for the onboarding flow?',
      'motion is nice but maybe 160ms instead of 300?',
      'I would drop the divider entirely',
    ],
    scripted: [
      {
        daysAgo: 3,
        hour: 14,
        minute: 20,
        author: 'priya',
        text: 'Two directions for the settings page. **A** is denser, **B** is friendlier. Thoughts?',
        image: ['palette', 'bars'],
      },
      {
        daysAgo: 3,
        hour: 14,
        minute: 31,
        author: 'samir',
        text: 'B, but steal the section headers from A',
        replyTo: 1,
        reactions: [['💯', 'priya']],
      },
      {
        daysAgo: 3,
        hour: 14,
        minute: 35,
        author: 'mireille',
        text: 'agree with Samir. A feels like a spreadsheet 😅',
      },
    ],
  },
  {
    key: 'orchard-release',
    kind: 'group',
    title: 'Orchard · Release Train',
    description: 'Releases, rollouts and incidents. Keep it factual.',
    members: ['dev', 'ines', 'oren', 'tomasz'],
    admins: ['dev'],
    activity: 0.9,
    unread: 3,
    pinned: true,
    lines: [
      '🚂 release 4.12.0 cut from `main`',
      'staged rollout at 25%, crash-free sessions 99.8%',
      'holding the rollout, investigating a login regression',
      'hotfix is building',
      'rollout resumed',
      'release notes draft is in the doc, please add your bits',
      'android build is stuck in review again',
      '{@me} can you confirm the migration is backwards compatible?',
      'all green, going to 100%',
      'post-mortem scheduled for Monday',
    ],
    scripted: [
      {
        daysAgo: 0,
        hour: 9,
        minute: 12,
        author: 'dev',
        text: '**Release 4.13.0** is cut 🚂\n\nChecklist:\n1. smoke tests — `pending`\n2. changelog — done\n3. staged rollout — 5% at 14:00',
      },
      {
        daysAgo: 0,
        hour: 9,
        minute: 20,
        author: 'dev',
        text: '{@me} you are on the smoke tests today, ping me when done ||and yes there are snacks||',
      },
      { daysAgo: 0, hour: 9, minute: 26, author: 'oren', text: 'I will shadow if that helps' },
    ],
  },
  {
    key: 'orchard-watercooler',
    kind: 'group',
    title: 'Orchard · Watercooler',
    description: 'Off-topic. Pets, plants, lunch.',
    members: ['ines', 'tomasz', 'priya', 'oren', 'mireille', 'dev', 'samir', 'tavi'],
    activity: 1.3,
    muted: false,
    lively: true,
    lines: [
      'anyone up for the ramen place today?',
      'my cat has learned to open the cupboard. we are doomed',
      'the good coffee beans are back in the kitchen ☕',
      'recommend me a podcast for a long drive',
      'photo from my walk this morning',
      'does anyone have a spare phone charger?',
      'rain again, shocking',
      'friday lunch vote: tacos or dumplings?',
      'dumplings, obviously',
      '{@} your sourdough last week was unreal',
      'I finally finished that 1000-piece puzzle',
      'who left a single grape on the meeting room table',
      'the office plant has a new leaf 🌱',
      'evacuation drill at 11, just so you know',
    ],
    scripted: [
      {
        daysAgo: 4,
        hour: 12,
        minute: 40,
        author: 'samir',
        text: 'Developed a roll from the coast trip',
        image: ['sunset', 'peaks'],
        reactions: [
          ['😮', 'priya'],
          ['❤️', 'ines'],
          ['❤️', 'tavi'],
          ['🎯', 'me'],
        ],
      },
      {
        daysAgo: 4,
        hour: 12,
        minute: 44,
        author: 'priya',
        text: 'the colours on the first one!!',
        replyTo: 1,
      },
    ],
  },

  // ─── Climbing club ───────────────────────────────────────────────────
  {
    key: 'crux',
    kind: 'group',
    title: 'Crux Collective',
    description:
      'Our climbing club 🧗 Sessions Tue/Thu at the Old Mill, outdoor trips when the weather behaves.',
    members: ['lucia', 'kofi', 'hana', 'rafferty', 'sunniva', 'emeka', 'wren'],
    admins: ['lucia', 'kofi'],
    activity: 1.5,
    unread: 6,
    lively: true,
    lines: [
      'who is in for Thursday session?',
      'I am in 🙋',
      'new set in the cave is *spicy*',
      'the pink V4 is sandbagged, change my mind',
      'finally sent the overhang project!!',
      'skin is destroyed, taking a rest day',
      'anyone have tape? I forgot mine',
      'warm up on the slab wall, then projects?',
      '{@} what was the beta for the heel hook on the blue one?',
      'the wall is packed tonight, maybe go at 8',
      'got my first V5 today 🎉',
      'forearms are *gone*',
      'brought banana bread for after',
      'the new holds on the comp wall are so good',
      'I will bring the hangboard protocol printout',
      'reminder to log your routes on the sheet',
    ],
    scripted: [
      {
        daysAgo: 5,
        hour: 19,
        minute: 5,
        author: 'kofi',
        system: 'Kofi Marlowe changed the group name to "Crux Collective".',
      },
      {
        daysAgo: 1,
        hour: 20,
        minute: 15,
        author: 'hana',
        text: 'Session pics!',
        image: 'peaks',
        reactions: [
          ['🧗', 'lucia'],
          ['🎯', 'kofi'],
          ['🎯', 'emeka'],
        ],
      },
      {
        daysAgo: 0,
        hour: 7,
        minute: 58,
        author: 'lucia',
        text: 'Morning all ☀️ Long one, sorry. For the trip this weekend: we meet at the car park at **8:30**, bring your own lunch, and please double check your harness and belay device the night before — last time we lost forty minutes looking for a locking carabiner in the boot of a car. Kofi has the ropes, Rafferty is driving the van, and Sunniva is our trad lead so listen to her. Forecast says dry until 4pm, so we will aim for the south-facing crag first and move to the shaded wall after lunch. If you are new, *tell someone* so we can pair you up. See you there!',
        reactions: [
          ['👍', 'rafferty'],
          ['👍', 'sunniva'],
          ['🙏', 'wren'],
        ],
      },
      {
        daysAgo: 0,
        hour: 8,
        minute: 12,
        author: 'wren',
        text: 'first outdoor trip for me! {@me} can I pair with you?',
      },
    ],
  },
  {
    key: 'crux-trips',
    kind: 'group',
    title: 'Crux · Trip Planning',
    description: 'Logistics for outdoor trips. Lifts, gear, forecasts.',
    members: ['lucia', 'rafferty', 'sunniva', 'kofi'],
    admins: ['lucia'],
    activity: 0.8,
    expireTimerSec: 604_800,
    lines: [
      'forecast looks decent for Saturday',
      'I can take three in the van',
      'who has the guidebook?',
      'parking fills up by 9, let us leave early',
      'I will bring the stove and coffee',
      'camping or day trip?',
      'the access path is closed, we need the long approach',
      '{@} can you share the topo again?',
    ],
    scripted: [
      {
        daysAgo: 6,
        hour: 18,
        minute: 0,
        author: 'lucia',
        system: 'Lucía Fenwick set disappearing messages to 1 week.',
      },
      {
        daysAgo: 2,
        hour: 21,
        minute: 3,
        author: 'sunniva',
        text: 'Topo for the south crag attached',
        file: { fileName: 'south-crag-topo.pdf', contentType: 'application/pdf', size: 2_483_110 },
      },
      { daysAgo: 2, hour: 21, minute: 10, author: 'rafferty', text: 'legend, thanks', replyTo: 1 },
    ],
  },
  {
    key: 'crux-gear',
    kind: 'group',
    title: 'Crux · Gear Swap',
    description: 'Buy, sell, lend. Be honest about wear.',
    members: ['emeka', 'hana', 'wren', 'kofi', 'sunniva', 'lucia'],
    activity: 0.4,
    muted: true,
    lines: [
      'selling size 41 shoes, lightly used',
      'anyone want a crash pad? moving flats',
      'looking for a 60m rope, can borrow for a weekend',
      'belay glasses change lives, I will not be taking questions',
      'free chalk bag, just come pick it up',
      'is a 9.8mm rope OK for the gym?',
    ],
  },

  // ─── Family ──────────────────────────────────────────────────────────
  {
    key: 'family',
    kind: 'group',
    title: 'Hale Family',
    description: 'Sunday lunch coordination and photos of the garden.',
    members: ['mum', 'dad', 'nan', 'bram'],
    admins: ['mum'],
    activity: 1.1,
    unread: 2,
    pinned: true,
    lines: [
      'Sunday lunch at ours? 1pm',
      'who is bringing dessert',
      'Dad has fixed the shed door. Again.',
      'call me when you get a minute x',
      'the tomatoes are finally ripening 🍅',
      'Nan says hello',
      'did anyone take my umbrella',
      'happy to drive Nan over',
      '{@me} are you coming this weekend?',
      'love you all',
      'photo from the garden this morning',
      'the dog stole a whole sausage off the counter',
    ],
    scripted: [
      {
        daysAgo: 3,
        hour: 10,
        minute: 5,
        author: 'mum',
        text: 'The garden this morning 🌸',
        image: 'garden',
        reactions: [
          ['❤️', 'nan'],
          ['❤️', 'me'],
          ['😍', 'bram'],
        ],
      },
      {
        daysAgo: 3,
        hour: 10,
        minute: 20,
        author: 'dad',
        text: 'I did the weeding for the record',
        replyTo: 1,
        reactions: [['😂', 'bram']],
      },
    ],
  },
  {
    key: 'cousins',
    kind: 'group',
    title: 'Cousins Corner',
    members: ['cleo', 'felix', 'bram'],
    activity: 0.8,
    lines: [
      'who is going to the wedding?',
      'I have *thoughts* about the seating plan',
      'group gift idea: a really nice teapot?',
      'Felix played cello at the recital and nobody cried, huge success',
      'can someone send me the address',
      'I will make a spreadsheet, as is tradition',
      '{@} remember the camping trip with the goat',
    ],
  },
  {
    key: 'recipes',
    kind: 'group',
    title: "Nan's Recipe Box",
    description: 'Family recipes, typed up before they are lost to time.',
    members: ['nan', 'mum', 'cleo'],
    admins: ['nan'],
    activity: 0.3,
    lines: [
      'what temperature for the apple pie?',
      'the secret is cold butter',
      'I tried the soup recipe, perfect for this weather',
      'do you have the one with the lemon drizzle?',
    ],
    scripted: [
      {
        daysAgo: 4,
        hour: 16,
        minute: 30,
        author: 'nan',
        text: "**Plum crumble** (serves 6)\n\n*Fruit:* 800g plums, 2 tbsp brown sugar, pinch of cinnamon\n*Top:* 180g flour, 100g cold butter, 80g sugar, handful of oats\n\nRub the butter into the flour until it looks like sand. Scatter over the fruit. 40 minutes at 180°C until golden. ||Add a splash of orange juice to the plums, but don't tell your mother.||",
        reactions: [
          ['❤️', 'mum'],
          ['🥧', 'cleo'],
          ['❤️', 'me'],
        ],
      },
      {
        daysAgo: 4,
        hour: 16,
        minute: 45,
        author: 'mum',
        text: 'I can see that spoiler, Mum',
        replyTo: 1,
        reactions: [
          ['😂', 'cleo'],
          ['😂', 'me'],
        ],
      },
    ],
  },

  // ─── Home (unassigned groups) ────────────────────────────────────────
  {
    key: 'books',
    kind: 'group',
    title: 'Book Nook',
    description: 'One book a month. No spoilers without ||spoiler tags||.',
    members: ['annika', 'samir', 'beatrix', 'tavi'],
    admins: ['annika'],
    activity: 0.6,
    unread: 1,
    lines: [
      'halfway through, no spoilers please',
      'that ending!!',
      'next month: something short, I beg',
      'I listened to the audiobook, the narrator was great',
      '{@} what did you think of the middle section?',
      'meeting at the café on the 14th?',
      '||the letter was from her sister the whole time||',
    ],
  },
  {
    key: 'allotment',
    kind: 'group',
    title: 'Allotment Plot 14',
    description: 'Watering rota and harvest brags.',
    members: ['jonah', 'odette', 'mum'],
    activity: 0.5,
    lines: [
      'watered everything this morning',
      'slugs got the lettuce again',
      'the sunflowers are taller than me now',
      'who is on rota this weekend?',
      'I left some courgettes by the gate, help yourselves',
      'compost bin is full, turning it on Sunday',
    ],
    scripted: [
      {
        daysAgo: 2,
        hour: 8,
        minute: 15,
        author: 'jonah',
        text: 'Harvest haul',
        image: 'garden',
        reactions: [['🌻', 'odette']],
      },
    ],
  },

  // ─── Direct messages ─────────────────────────────────────────────────
  {
    key: 'dm-ines',
    kind: 'direct',
    members: ['ines'],
    activity: 0.8,
    unread: 1,
    lines: [
      'got a sec for a quick call?',
      'thanks for covering the review',
      'I will send you the draft tonight',
      'do you want to present or shall I?',
      'the meeting moved to 3',
    ],
  },
  {
    key: 'dm-lucia',
    kind: 'direct',
    members: ['lucia'],
    activity: 0.9,
    pinned: true,
    lines: [
      'climbing tonight?',
      'I will pick you up at 7',
      'bring the spare harness for Wren',
      'my fingers still hurt from Thursday',
      'coffee after?',
    ],
  },
  {
    key: 'dm-mum',
    kind: 'direct',
    members: ['mum'],
    activity: 0.6,
    lines: [
      'are you eating properly',
      'call your Nan, she misses you',
      'I found your old school reports in the attic 😂',
      'lovely to see you on Sunday x',
    ],
  },
  {
    key: 'dm-bram',
    kind: 'direct',
    members: ['bram'],
    activity: 0.5,
    unread: 2,
    lines: [
      'can I borrow your amp',
      'band practice moved to Friday',
      'did you tell Mum about the thing',
      'listen to this track, trust me',
    ],
  },
  {
    key: 'dm-priya',
    kind: 'direct',
    members: ['priya'],
    activity: 0.5,
    lines: [
      'what do you think of this type pairing?',
      'sent you the figma link',
      'lunch tomorrow?',
      'your feedback in crit was really helpful',
    ],
  },
  {
    key: 'dm-beatrix',
    kind: 'direct',
    members: ['beatrix'],
    activity: 0.4,
    lines: [
      'your bowl came out of the kiln perfectly',
      'glaze day on Saturday?',
      'the studio heater is broken again',
      'I will save you a wheel',
    ],
    scripted: [
      {
        daysAgo: 1,
        hour: 18,
        minute: 2,
        author: 'beatrix',
        text: 'Firing schedule for next month',
        file: { fileName: 'kiln-schedule-october.txt', contentType: 'text/plain', size: 1_204 },
      },
    ],
  },
  {
    key: 'dm-rafferty',
    kind: 'direct',
    members: ['rafferty'],
    activity: 0.4,
    lines: [
      'van is booked for the weekend',
      'fuel money split four ways?',
      'I will bring the playlist',
    ],
  },
  {
    key: 'dm-oren',
    kind: 'direct',
    members: ['oren'],
    activity: 0.4,
    lines: ['pager went off again 😩', 'can you take my on-call Tuesday?', 'owe you a coffee'],
  },
  {
    key: 'dm-annika',
    kind: 'direct',
    members: ['annika'],
    activity: 0.3,
    lines: ['you have to read this one next', 'I will lend you my copy', 'the library has it now'],
  },
  {
    key: 'dm-tavi',
    kind: 'direct',
    members: ['tavi'],
    activity: 0.2,
    lines: ['still up?', 'found a great late-night noodle place', 'sent you that playlist'],
    historyArchived: true,
  },
];

/** Default spaces created on the first demo run. */
export const DEFAULT_SPACES: readonly SpaceSeed[] = [
  {
    name: 'Work',
    emoji: '💼',
    categories: [
      { name: 'Teams', conversations: ['orchard-eng', 'orchard-design', 'orchard-release'] },
      { name: 'Social', conversations: ['orchard-watercooler'] },
    ],
  },
  {
    name: 'Climbing Club',
    emoji: '🧗',
    categories: [
      { name: 'Chats', conversations: ['crux', 'crux-gear'] },
      { name: 'Trips', conversations: ['crux-trips'] },
    ],
  },
  {
    name: 'Family',
    emoji: '🏡',
    categories: [{ name: 'Chats', conversations: ['family', 'cousins', 'recipes'] }],
  },
];
