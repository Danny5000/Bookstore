// Placeholder manuscript text. Replace with real content, or load from the DB.
export const BANK = [
  'The tide came in grey that season, and with it the salt that would pay for everything we did next. We worked the flats at low water, three of us and a borrowed rake, while the station lights burned overhead like a town that had forgotten to come down.',
  'Ceren said the orbital was drifting again. She said it the way you mention weather, or a debt. I kept my eyes on the shallow water and counted the crystals forming along the rope, small and patient and entirely indifferent to whether we lived.',
  'There is a particular arithmetic to being poor on a company world. You learn the price of everything twice: once in credit, once in the hours it costs to earn the credit. By the second winter I could do the second sum faster than the first.',
  'The freighter came down at dusk with its heat shields still ticking. Nobody went out to meet it. That was how you could tell the place had changed - a ship used to be an event, and now it was only a schedule.',
  'I have tried to write this part honestly. What happened at the harvest was not heroic and it was not clean, and the version they tell in the corridors has a shape that real things never have.',
  'Later, when the inquiry asked me to describe the moment the ring failed, I said it looked like a sentence being erased. They wanted metaphors. I had spent four years learning to see machines as machines, and they wanted metaphors.',
  'We slept in shifts under the conveyor, where the noise was worst and the wind was least. Ceren dreamed out loud. Once she said a name I did not know and then apologized for it in the morning, which told me more than the name would have.',
  'The salt kept coming. That was the thing about the flats - they did not care about the inquiry, or the ring, or the men who arrived in clean coats to measure our grief in units. Every twelve hours the water went out and left its wages behind.',
  'My contract said eighteen months and a berth home. It also said, in a clause I did not read until the second spring, that the berth was subject to availability, and that availability was a determination made by the company.',
  'Ostergaard ran the flats for the company and had the particular gentleness of a man who has never once had to say no in person. He signed things. Somewhere above us a machine turned his signature into weather.',
  'There were nights the ring was so bright you could read by it. We did, sometimes - the three of us passing a reader between us, arguing about a book none of us had finished, while the pumps knocked and the water crept.',
  'You could see the fault from the ground if you knew where to look: a seam of dark against the lit arc, widening by a hair a month. For two years the official position was that the seam was a shadow.',
  'The first time I said the word sabotage out loud, Ceren put her hand flat on the table, the way you steady a glass on a ship. Not here, she said. Not with that word. Say it the way an engineer would say it, or do not say it.',
  'What an engineer would say is: the tolerance had been exceeded, and the party responsible for the tolerance had been reassigned. That is the whole story, told properly. Everything else is just the part where people live in it.'
];

export function prose(seed, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(BANK[(seed + i) % BANK.length]);
  return out;
}

export function chapters(seed, names) {
  return names.map((title, i) => ({ title, paras: prose(seed + i * 5, 9 + (i % 3)) }));
}
