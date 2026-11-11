const groups = {
  'Simple orders': [
    ['I’d like a flat white, please.', 'flat white'],
    ['Can I have a bowl of tomato soup?', 'tomato soup'],
    ['A toasted ham and cheese sandwich, please.', 'toasted|ham and cheese']
  ],
  'Multiple items': [
    ['One cheeseburger and two large fries, please.', 'one|cheeseburger|two|large fries'],
    ['I’ll have a fish taco, a side salad and a lemonade.', 'fish taco|side salad|lemonade'],
    ['Can we get garlic bread, two lasagnas and a jug of water?', 'garlic bread|two|lasagnas|jug of water']
  ],
  'Quantities': [
    ['I need six chicken nuggets and three barbecue sauces.', 'six|chicken nuggets|three|barbecue sauces'],
    ['Could we get twelve oysters and four lemon wedges?', 'twelve|oysters|four|lemon wedges'],
    ['Two portions of dumplings and one bowl of rice.', 'two|dumplings|one|rice']
  ],
  'Sizes': [
    ['Make that a small iced tea and a large hot chocolate.', 'small iced tea|large hot chocolate'],
    ['A medium chips and an extra large cola, please.', 'medium chips|extra large cola'],
    ['I’ll take the regular poke bowl with a small sparkling water.', 'regular poke bowl|small sparkling water']
  ],
  'Food modifiers': [
    ['One large cappuccino, extra hot, no sugar.', 'one|large cappuccino|extra hot|no sugar'],
    ['Add avocado and put the dressing on the side.', 'add avocado|dressing on the side'],
    ['Could I get my steak medium rare with extra pepper?', 'steak|medium rare|extra pepper']
  ],
  'Negative instructions': [
    ['Can I get a chicken burger with no onions?', 'chicken burger|no onions'],
    ['Please leave out the peanuts and don’t add sesame oil.', 'leave out|peanuts|don’t add|sesame oil'],
    ['The salad without croutons and the wrap without cheese.', 'without croutons|without cheese']
  ],
  'Fillers and hesitations': [
    ['Uh, I’d like two iced lattes, um, with oat milk.', 'uh|two|iced lattes|um|oat milk'],
    ['Um, can I get, uh, a veggie burger and a small fries?', 'um|uh|veggie burger|small fries'],
    ['Er, I think I’ll have the pumpkin soup with, um, sourdough.', 'er|pumpkin soup|um|sourdough']
  ],
  'Self-corrections': [
    ['Actually, make that three coffees instead of two.', 'three|coffees|instead of two'],
    ['I’ll have a beef taco, sorry, a fish taco with no salsa.', 'beef taco|fish taco|no salsa'],
    ['One medium latte, wait, make it a large flat white.', 'medium latte|large flat white']
  ],
  'Uncommon menu names': [
    ['Can I get a fettuccine Alfredo and a sparkling water?', 'fettuccine Alfredo|sparkling water'],
    ['I’d like the shakshuka and a side of labneh.', 'shakshuka|labneh'],
    ['We’ll share the okonomiyaki and the yuzu granita.', 'okonomiyaki|yuzu granita']
  ],
  'Longer sentences': [
    ['For the table, could we get two margherita pizzas, one with extra basil and the other without mozzarella?', 'two|margherita pizzas|extra basil|without mozzarella'],
    ['I’d like the salmon with roast potatoes instead of rice, and could you put the lemon butter sauce on the side?', 'salmon|roast potatoes|instead of rice|lemon butter sauce|on the side'],
    ['Can I have three kids’ meals, two with apple juice and one with water, and please leave the pickles off all the burgers?', 'three|kids’ meals|two|apple juice|one|water|leave the pickles off']
  ]
};

let number = 0;
export const builtInCases = Object.entries(groups).flatMap(([category, rows]) =>
  rows.map(([reference, terms]) => ({
    id: 'ORD-' + String(++number).padStart(2, '0'),
    category, reference, audio: '', notes: '', criticalTerms: terms.split('|'), completed: false
  }))
);

export function parseDataset(input) {
  const cases = Array.isArray(input) ? input : input?.cases;
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('Dataset needs at least one case.');
  const ids = new Set();
  return cases.map((entry) => {
    const { id, reference, category, audio = '', notes = '', criticalTerms = [], completed = false } = entry ?? {};
    if (![id, reference, category].every(value => typeof value === 'string' && value.trim()) ||
        ![audio, notes].every(value => typeof value === 'string') ||
        !Array.isArray(criticalTerms) || criticalTerms.some(term => typeof term !== 'string') ||
        typeof completed !== 'boolean') throw new Error('Invalid case. Each case needs an ID, category and reference.');
    if (ids.has(id.trim())) throw new Error('Duplicate case ID: ' + id.trim());
    ids.add(id.trim());
    return { id: id.trim(), category, reference, audio, notes, criticalTerms, completed };
  });
}
