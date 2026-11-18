// A synthetic, labelled personal-data set. Every value is fake: test card numbers, documentation
// IBANs, 555-01xx phone numbers, reserved IP ranges where possible, invented names and addresses.
import { rng, sample } from "./data.mjs";

const PEOPLE = [
  "Jordan Lee",
  "Priya Raman",
  "Mateo Alvarez",
  "Aisha Bello",
  "Chen Wei",
  "Olivia Brooks",
  "Kwame Mensah",
  "Sofia Rossi",
  "Yuki Tanaka",
  "Liam O'Connor",
  "Fatima Zahra",
  "Noah Fischer",
  "Ananya Iyer",
  "Diego Herrera",
  "Hannah Kim",
  "Omar Haddad",
  "Grace Okafor",
  "Lucas Martin",
  "Mei Lin",
  "Arjun Mehta",
  "Elena Petrova",
  "Samuel Adeyemi",
  "Chloe Dubois",
  "Ravi Shankar",
];
const STREETS = [
  "742 Evergreen Terrace, Springfield",
  "1600 Larkspur Lane, Fairview",
  "221 Baker Avenue, Riverton",
  "88 Harbor Road, Bayport",
  "4100 Maple Drive, Cedar Falls",
  "17 Willow Court, Brookhaven",
];
const PHONES = ["(415) 555-0132", "+1 212-555-0147", "(617) 555-0199", "+1 503 555 0110", "+44 20 7946 0958"];
const CARDS = [
  "4111 1111 1111 1111",
  "5555 5555 5555 4444",
  "3782 822463 10005",
  "6011 1111 1111 1117",
  "4012888888881881",
];
const IBANS = [
  "GB82 WEST 1234 5698 7654 32",
  "DE89 3704 0044 0532 0130 00",
  "NL91ABNA0417164300",
  "FR14 2004 1010 0505 0001 3M02 606",
];
const SSNS = ["123-45-6789", "078-05-1120", "219-09-9999", "457-55-5462"];
const IPS = ["203.0.113.42", "198.51.100.7", "192.0.2.15", "2001:db8::1f"];

const TEMPLATES = [
  "Hi, I'm {PERSON}. You can reach me at {EMAIL} or {PHONE}.",
  "Please charge card {CREDIT_CARD} and send the receipt to {EMAIL}.",
  "Wire the deposit to IBAN {IBAN}; the account holder is {PERSON}.",
  "My SSN is {US_SSN} and my mailing address is {ADDRESS}.",
  "The server at {IP_ADDRESS} rejected the login for {PERSON} this morning.",
  "Can you draft a reply to {PERSON} ({EMAIL}) about the late invoice?",
  "Ship the replacement to {PERSON}, {ADDRESS}. Call {PHONE} if nobody answers.",
  "{PERSON} asked whether card {CREDIT_CARD} was charged twice.",
  "Summarize this ticket: customer {PERSON}, phone {PHONE}, says the refund never arrived.",
  "Update the CRM: {EMAIL} now belongs to {PERSON}, who moved to {ADDRESS}.",
];

const NEGATIVES = [
  "Order #48213 shipped on 2026-11-02 with a total of $1,284.50.",
  "Version 4.2.1 of the API listens on port 8080 behind the load balancer.",
  "The meeting is in Room 1203 at 3:30pm; bring the Q3 slides.",
  "Use the code SAVE20 for 20% off orders over $50.",
  "Apple released the new MacBook in California last week.",
  "Our office in Berlin is closed on public holidays.",
  "Tracking number 1Z999AA10123456784 shows the package in transit.",
  "The recipe calls for 2 cups of flour and 350 grams of sugar.",
  "Invoice INV-2026-0042 is due in 30 days.",
  "Restart the worker with --max-memory 4096 and check the logs.",
  "The Pythagorean theorem states that a² + b² = c².",
  "Set the timeout to 120000 ms and retry three times.",
];

export function piiCases(seed = 7) {
  const random = rng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const cases = [];
  for (let i = 0; i < 240; i++) {
    const template = TEMPLATES[i % TEMPLATES.length];
    const person = pick(PEOPLE);
    const values = {
      PERSON: person,
      EMAIL: `${person.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
      PHONE: pick(PHONES),
      CREDIT_CARD: pick(CARDS),
      IBAN: pick(IBANS),
      US_SSN: pick(SSNS),
      IP_ADDRESS: pick(IPS),
      ADDRESS: pick(STREETS),
    };
    let text = "";
    const spans = [];
    let last = 0;
    for (const m of template.matchAll(/\{([A-Z_]+)\}/g)) {
      text += template.slice(last, m.index);
      const value = values[m[1]];
      spans.push({ entity: m[1], start: text.length, end: text.length + value.length, text: value });
      text += value;
      last = m.index + m[0].length;
    }
    text += template.slice(last);
    cases.push({ text, spans });
  }
  for (const text of sample(NEGATIVES, NEGATIVES.length, random)) cases.push({ text, spans: [] });
  return cases;
}
