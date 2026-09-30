/**
 * Fictional people for the demo world. Names are invented combinations;
 * any resemblance to real people is coincidental.
 */

export interface PersonSeed {
  key: string;
  name: string;
  profileName?: string;
  about?: string;
  aboutEmoji?: string;
  /** Share their number with us? (Signal lets people hide it.) */
  sharesNumber: boolean;
}

export const SELF: PersonSeed = {
  key: 'me',
  name: 'Juniper Hale',
  profileName: 'Juniper',
  about: 'Building things, breaking pottery',
  aboutEmoji: '🏺',
  sharesNumber: true,
};

export const PEOPLE: readonly PersonSeed[] = [
  {
    key: 'ines',
    name: 'Ines Okafor',
    about: 'Staff engineer · tea over coffee',
    aboutEmoji: '🍵',
    sharesNumber: true,
  },
  {
    key: 'tomasz',
    name: 'Tomasz Wren',
    profileName: 'Tom',
    about: 'Ships on Thursdays',
    aboutEmoji: '🚢',
    sharesNumber: false,
  },
  {
    key: 'priya',
    name: 'Priya Castellan',
    about: 'Design systems & tiny type',
    aboutEmoji: '✏️',
    sharesNumber: true,
  },
  {
    key: 'oren',
    name: 'Oren Blackwood',
    about: 'On call, please be kind',
    aboutEmoji: '📟',
    sharesNumber: true,
  },
  {
    key: 'mireille',
    name: 'Mireille Tanaka',
    about: 'Product · asks why five times',
    aboutEmoji: '🧭',
    sharesNumber: false,
  },
  {
    key: 'dev',
    name: 'Dev Ashcombe',
    about: 'Release captain',
    aboutEmoji: '⚓',
    sharesNumber: true,
  },
  {
    key: 'lucia',
    name: 'Lucía Fenwick',
    about: 'Bouldering, mostly falling',
    aboutEmoji: '🧗',
    sharesNumber: true,
  },
  {
    key: 'kofi',
    name: 'Kofi Marlowe',
    about: 'Route setter at the old mill',
    aboutEmoji: '🪨',
    sharesNumber: false,
  },
  {
    key: 'hana',
    name: 'Hana Lindqvist',
    about: 'Chalk is a lifestyle',
    aboutEmoji: '🤍',
    sharesNumber: true,
  },
  {
    key: 'rafferty',
    name: 'Rafferty Obi',
    profileName: 'Raff',
    about: 'Van life, weekend edition',
    aboutEmoji: '🚐',
    sharesNumber: true,
  },
  {
    key: 'sunniva',
    name: 'Sunniva Park',
    about: 'Trad or nothing',
    aboutEmoji: '⛰️',
    sharesNumber: false,
  },
  {
    key: 'emeka',
    name: 'Emeka Thornbury',
    about: 'Belay glasses evangelist',
    aboutEmoji: '👓',
    sharesNumber: true,
  },
  {
    key: 'wren',
    name: 'Wren Galloway',
    about: 'Knots and knitting',
    aboutEmoji: '🧶',
    sharesNumber: true,
  },
  {
    key: 'mum',
    name: 'Rosalind Hale',
    profileName: 'Mum',
    about: 'Gardening. Ask me about tomatoes.',
    aboutEmoji: '🍅',
    sharesNumber: true,
  },
  {
    key: 'dad',
    name: 'Gideon Hale',
    profileName: 'Dad',
    about: 'Fixing the shed since 2019',
    aboutEmoji: '🔨',
    sharesNumber: true,
  },
  {
    key: 'nan',
    name: 'Maud Hale',
    profileName: 'Nan',
    about: 'Recipes available on request',
    aboutEmoji: '🥧',
    sharesNumber: true,
  },
  {
    key: 'bram',
    name: 'Bram Hale',
    about: 'Little brother, big opinions',
    aboutEmoji: '🎸',
    sharesNumber: true,
  },
  {
    key: 'cleo',
    name: 'Cleo Varga',
    about: 'Cousin · chaos coordinator',
    aboutEmoji: '🌪️',
    sharesNumber: false,
  },
  {
    key: 'felix',
    name: 'Felix Varga',
    about: 'Currently learning the cello',
    aboutEmoji: '🎻',
    sharesNumber: true,
  },
  {
    key: 'annika',
    name: 'Annika Moreau',
    about: 'Reads three books at once',
    aboutEmoji: '📚',
    sharesNumber: true,
  },
  {
    key: 'jonah',
    name: 'Jonah Pell',
    about: 'Allotment plot 14, the one with the sunflowers',
    aboutEmoji: '🌻',
    sharesNumber: true,
  },
  {
    key: 'odette',
    name: 'Odette Quill',
    about: 'Compost is a love language',
    aboutEmoji: '🪱',
    sharesNumber: false,
  },
  {
    key: 'samir',
    name: 'Samir Delacroix',
    about: 'Film photography, slow replies',
    aboutEmoji: '📷',
    sharesNumber: true,
  },
  { key: 'tavi', name: 'Tavi Nakamura', about: 'Night owl', aboutEmoji: '🦉', sharesNumber: true },
  {
    key: 'beatrix',
    name: 'Beatrix Holm',
    about: 'Ceramics studio mate',
    aboutEmoji: '🏺',
    sharesNumber: true,
  },
];
