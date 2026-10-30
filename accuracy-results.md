# Accuracy results

Real-model voice-note accuracy, 2026-10-30 11:36 UTC. Each wav in `test-audio/expected.json` sent 3x through the real WhatsApp voice-note path (`propose` with `{ audioPath }`, real Meta client, nothing confirmed). Audio model `muse-spark-1.2`, sampling `temperature: 0` + `seed: 7` (text model `muse-spark-1.3` unused here); second opinion on. Customer names score by whole-name equality after normalisation (lowercase, titles stripped, all spaces removed): titles, case and spacing forgiven; substring and typo matches never count. Flagged = question, warning, locked Save, second-opinion disagreement or usual-price note. Cells show runs out of 3. Consistency is the largest group of identical runs.

## Empty shop

| Note | Said | Types | Amounts | Customers | Count | Consistency | Correct | Wrong, flagged | Wrong, silent |
|---|---|---|---|---|---|---|---|---|---|
| WhatsApp Ptt 2026-10-30 at 10.21.38.wav | Mama Chinedu buy 2 bag of rice, 15k each, she pay 25k. | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 | 3/3 | 0/3 | 0/3 |
| WhatsApp Ptt 2026-10-30 at 10.21.50.wav | Ada don pay 5k for the rice wey she buy. | 0/3 | 3/3 | 1/3 | 3/3 | 2/3 | 0/3 | 3/3 | 0/3 |
| WhatsApp Ptt 2026-10-30 at 10.21.57.wav | I bought 10 bags of rice at 45k each. | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 |
| WhatsApp Ptt 2026-10-30 at 10.22.10.wav | Bola buy garri 3 mudu, 4500 total, e pay 2000. | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 |
| WhatsApp Ptt 2026-10-30 at 10.22.17.wav | Paid shop rent for November, 150000. | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 |
| n06.wav | Aunty Ngozi collect 3 cartons of Indomie, 27k total, she never pay. | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 | 3/3 | 0/3 | 0/3 |
| n07.wav | Oga Tunde don pay 10k. | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 |
| n08.wav | I spent 3k on transport and 2k on fuel. | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 |
| n09.wav | I buy 5 crates of eggs for 40k. | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 |
| n10.wav | Mama Bisi buy 4 paint of beans, 3 thousand each, she pay 5k. | 3/3 | 3/3 | 0/3 | 3/3 | 2/3 | 0/3 | 3/3 | 0/3 |
| n11.wav | Alhaji Musa don pay 20k for the rice wey e take last week. | 3/3 | 3/3 | 0/3 | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 |
| n12.wav | Chinedu buy 6 tins of tomato, 1500 each, e pay 5k. | 2/3 | 0/3 | 2/3 | 2/3 | 2/3 | 0/3 | 3/3 | 0/3 |
| n13.wav | Paid electricity bill, 18k. | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 |
| n14.wav | Ada buy 1 bag of rice, 33k, she pay 33k. | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 |
| n15.wav | Bola don pay the remain 2500. | 3/3 | 0/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 |
| n16.wav | (Yoruba) Mama Eniola bought a bottle of coke, she owes me 5k. | 1/3 | 1/3 | 1/3 | 1/3 | 2/3 | 1/3 | 2/3 | 0/3 |

Overall: 31/48 runs fully correct; wrong but flagged 17/48; SILENTLY WRONG 0/48.
