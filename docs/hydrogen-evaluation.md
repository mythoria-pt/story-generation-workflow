# Hydrogen evaluation — 13 November 2026

The final Hydrogen variants completed every expected chapter and passed structural validation. The automated anonymized editorial review accepted both Hydrogen approaches in both fixtures. Whole-story generation was faster and cheaper in these examples, but produced shorter manuscripts; the results do not establish general model superiority.

## Controlled text-generation results

| Fixture and method              | Chapters |  Words | Wall time | Standard API cost, USD |
| ------------------------------- | -------: | -----: | --------: | ---------------------: |
| Preschool: Flash sequential     |        4 |  1,069 |     87.6s |                $0.0389 |
| Preschool: Hydrogen sequential  |        4 |  1,147 |     66.3s |                $0.1205 |
| Preschool: Hydrogen whole       |        4 |    561 |     13.0s |                $0.0219 |
| Adult: Flash sequential         |       10 | 16,985 |    499.3s |                $0.2510 |
| Adult: Hydrogen sequential (v2) |       10 | 30,714 |    578.1s |                $0.9243 |
| Adult: Hydrogen whole (v2)      |       10 | 13,613 |    153.1s |                $0.1522 |

The preschool fixture was a four-chapter European Portuguese kindness story about Lia, her dog Pipo and a lost blue kite. The adult fixture was a ten-chapter English literary story about Mara, her father's tide notebooks, a flood threat in fictional Bellhaven, and her relationship with harbor master Tomas. Every variant used the same fixture description and fixed outline. These are fictional materials, not customer stories.

For the adult example, whole-story Hydrogen was about 69% faster and 39% cheaper than the Flash replay, with about 20% fewer words. Hydrogen sequential produced about 81% more words than Flash, took about 16% longer, and cost about 3.7 times as much. Longer output and billed thinking explain why a new model's nominal speed does not guarantee a faster or cheaper completed book.

## What changed after the initial trials

The first adult whole-story result contained all ten chapters but only 5,747 words. That was substantially compressed relative to the Flash replay's 16,985 words. The v2 prompts therefore include approximate teen/adult prose-depth guidance of 1,500-2,000 words per chapter, with explicit author length requests and concise genres taking precedence. Whole-story output increased to 13,613 words; sequential output reached 30,714 words. Neither approach followed the approximate word target exactly, so a larger token allowance is not a reliable length guarantee.

The initial sequential Hydrogen trial used an 8,192-token evaluation cap and hit MAX_TOKENS during chapter four. It was rejected, not accepted as a complete story. The retest used 65,536 tokens per chapter; production uses a configurable 131,072-token chapter ceiling and supports continuation. Whole-story evaluation used 131,072 tokens for the adult fixture; production defaults to 262,144. No comparison needed a real response beyond 65,536 tokens; continuation, thinking-only segments and restart handling were exercised by mocked contract tests.

A live SDK check also found that Developer API countTokens rejects native systemInstruction/tools config fields. The implementation instead includes their serialized text and output schema in the count request, retaining 8,192 tokens of headroom for formatting overhead. Actual generation retains the native system instruction and JSON schema.

## Quality observations and tradeoffs

The automated review found both Hydrogen preschool drafts coherent and age-appropriate. Sequential generation developed the characters more; the whole-story draft was more concise. For the adult fixture, both final Hydrogen drafts covered the required plot and reached a coherent ending. The sequential version had richer characterization but occasional technical over-explanation; the whole-story draft was tighter, with less emotional aftermath. These are limited model-assisted editorial observations, not a human study or a universal consistency claim.

A ten-chapter adult story therefore worked in one logical model turn in this test. That confirms feasibility for this example, not guaranteed novel length or completeness for every prompt. The configured production rule remains unchanged: ages 15+ with eight or more chapters use sequential Hydrogen; other combinations use whole-story Hydrogen. The audience list and threshold remain operator-configurable.

Whole-story generation reduces repeated requests and gives the model the entire arc at once. It delays committing chapters until the whole output validates, and a failure before a resumable checkpoint can waste more work. Sequential generation persists chapters progressively and limits the scope of retries, while repeating more input and potentially accumulating local pacing decisions. Continuation itself can rebill preceding tokens as input; it is not free extra output.

## Method, spending and limits

The baseline used the pre-change checkout's chapter prompt and explicit full prior-chapter text, replayed through the SDK. It did not reproduce every live Cloud Run session/cache behavior. The final adapter also moves stable outline/roster and growing chapter history before the changing task to improve implicit-cache eligibility; the isolated benefit of that reordering was not measured here. Image/audio generation, persistence and workflow orchestration are excluded from comparison timings and checked separately in release smoke tests.

Costs use provider-reported input, cached input, visible output and thinking tokens with published Standard rates. Flash's current input/output prices are promotional; Hydrogen currently costs twice as much per uncached input/output token. Results are one run per final variant and one fixture per audience, with different output lengths. Do not interpret these figures as statistically reliable production SLOs or equal-length creative comparisons.

The authorized evaluation and production-smoke allowance is EUR 10 total. Generation and editorial-review spending before production smoke is conservatively bounded by USD 2.1530 (EUR 2.5836 using a deliberately conservative budget factor of 1.20 EUR/USD). This includes discarded trials and the entire reserved upper-bound cost of one editorial response whose usage was not saved before a truncated-JSON parse failure. This budget factor is a safeguard, not an exchange-rate quote. Application cost estimates retain the repository's 0.92 USD-to-EUR factor. Actual cloud infrastructure, tax and account discounts are outside these token estimates.

Machine-readable results and editorial observations: [evaluation JSON](hydrogen-evaluation-2026-11-13.json). Operational configuration and recovery: [Hydrogen runbook](hydrogen-story-generation.md). Production smoke audit is retained locally in `tmp/hydrogen-smoke-state.json`; immutable deployment identifiers are reported with the release verification.

Sources: [Google pricing](https://aistudio.google.com/docs/pricing#gemini-4-hydrogen), [long decode](https://aistudio.google.com/docs/long-decode?generate-content=true), [Hydrogen guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-hydrogen).
