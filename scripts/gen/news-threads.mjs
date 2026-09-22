// Grows the five long Millrace threads, pages/news/threads/<id>.json, from
// their hand-written openings in news-seeds.mjs, and restates every stream
// item's reply count in pages/news/items.json and items2.json from its thread
// file, so the figure on the stream always matches the thread.
//
// This lives outside pages/ because everything under pages/ is served. Run it
// from the repo root:
//
//   node scripts/gen/news-threads.mjs
//
// Output is deterministic (one seeded generator per thread, no clock), so a
// re-run leaves `git status` clean.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEEDS } from './news-seeds.mjs';

const NEWS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pages', 'news');
const THREADS_DIR = join(NEWS, 'threads');

const MAX_DEPTH = 8;

// Short replies, questions and asides that fit any thread.
const GENERIC = [
  'This matches my experience almost exactly.',
  'Strong disagree, but I appreciate that you wrote it up properly.',
  'Do you have numbers for that? It sounds plausible but I have seen the opposite.',
  'I think you are both right and talking about different scales.',
  'The article addresses this about two thirds of the way down, for what it is worth.',
  'Same here, down to the {detail|footnote|punchline}.',
  'That is the part nobody budgets for.',
  'Counterpoint: it depends entirely on who is on call when it breaks.',
  'We had the same argument at work last {month|quarter|spring} and nobody changed their mind.',
  'I would love to read a follow-up on exactly this point.',
  'This is the comment I came here to write.',
  'Not sure that generalises beyond {your team|a small shop|one workload}.',
  'Every one of these threads has this subthread, and every time it is worth reading.',
  'Saving this for the next time someone asks me why.',
  'The honest answer is that nobody measured it before or after.',
  'You are describing a people problem with a technology label on it.',
  'I read it the other way: the tooling finally caught up with the idea.',
  'Worth separating what is hard from what is merely unfamiliar.',
  'That was true {five|ten|a few} years ago. It has moved a lot since.',
  'Genuinely curious what the failure mode looks like in year three.',
  'Agree with the conclusion, not with how you got there.',
  'The last paragraph of the post says nearly the same thing.',
  'That is a fair correction, thanks.',
  'I tried this and gave up after a {week|fortnight|month}. Might try again after this thread.',
  'The interesting bit is buried in a footnote, as usual.',
  'This deserves its own submission.',
  'Somebody should write the boring version of this post, with all the caveats.',
  'You can do it, but the maintenance cost arrives on a delay and it arrives anyway.',
  'People underestimate how much of this is just habit.',
  'We found the opposite, but our constraints were unusual.',
  'Mild pushback: the benchmark in the post is doing a lot of work.',
  'Right, and the second-order effect is the one that bites.',
  'I think the author would agree with you; the title oversells it.',
  'There is a whole conference talk on this that I cannot find right now.',
  'That is a very generous reading of the situation.',
  'This is why I stopped arguing about it and started measuring.',
  'Replying mainly so I can find this again.',
  'Reasonable people land on both sides of this, and the thread is proving it.',
  'The trade-off is real but it is not the one people usually name.',
  'Seconding this. It took us far too long to learn it.',
  'I have been on both sides of that decision and I still do not know which was right.',
  'Small correction: that changed in the last release, so the post is slightly out of date.',
  'Is that from the post or from your own setup? Curious either way.',
  'Nobody wants to hear it, but the unglamorous answer usually wins.',
  'Could you expand on that? The short version skips the part I care about.',
];

const SHORT = [
  'This.',
  'Ha, fair.',
  'Source?',
  'Thanks, that helps.',
  'Good question.',
  'Agreed.',
  'Seconded.',
  'Same.',
  'Not in my experience.',
  'Fair point.',
  'That tracks.',
  'Oof. Yes.',
  'Can confirm.',
  'Well put.',
  'Interesting, had not considered that.',
  'Exactly this.',
  'Hard agree.',
  'Noted, thanks.',
  'Touché.',
  'I stand corrected.',
];

const OPENERS = [
  'Honestly, ',
  'For what it is worth, ',
  'Anecdotally, ',
  'In my experience, ',
  'Having done this twice now: ',
  'Mild disagreement: ',
  'Worth adding that ',
  'The way I see it, ',
];

const TAILS = [
  ' Happy to be proven wrong.',
  ' Your mileage will vary.',
  ' At least that is how it went for us.',
  ' I say that as someone who likes the idea.',
  ' The post undersells this, I think.',
  ' Nobody talks about that part.',
];

// Each topic: comments that open a subthread, replies that stay on topic, and
// questions. A {a|b|c} group is one of its choices, drawn per comment.
const TOPICS = {
  spreadsheet: {
    top: [
      'The recalc numbers are impressive, but the thing that sold me was the dependency view. Being able to see which {region|block|cluster} of cells a formula compiled into explains the performance better than any benchmark.',
      'I maintain a {forecast|budget|pricing} workbook with about {forty|sixty|ninety} tabs and the slow part has never been arithmetic. It is lookups across tabs and a handful of volatile functions that everybody forgot were there.',
      'The fallback interpreter is the real product here. Compilation is an optimisation; bit-identical results between the two paths is what makes it safe to ship.',
      'Anyone who has tried to reproduce spreadsheet date arithmetic knows the 1900 leap-year compatibility bug is waiting for them. Curious whether the compiler keeps it or quietly fixes it.',
      'Spreadsheets are the most widely deployed reactive programming system in the world and we keep rediscovering that every {few years|decade|hype cycle}. This is a good rediscovery.',
      'The Wasm module size is the number I would watch. A sheet with {ten|twenty|thirty} thousand distinct formulas could easily produce a module bigger than the file it came from.',
      'Having shipped a formula engine for {six|eight|eleven} years: compatibility is where the time goes. Every edge case in text functions is load-bearing for somebody\'s payroll sheet.',
      'I like that the post is honest about what did not get faster. Cross-sheet references still dominate on the models I care about, and the author says so.',
      'Precision is going to be the recurring question. Accountants do not care that pairwise summation is more accurate; they care that the number matches last month\'s printout.',
      'The tiering design reminds me of a JavaScript engine: interpret first, compile the hot regions, swap in when ready. It is a proven pattern for a reason.',
      'This would be a great teaching project. Dependency graphs, strongly connected components, code generation and numerics, all in one familiar tool.',
      'What I want to know is how it behaves with a sheet that someone has been editing badly for {ten|fifteen|twenty} years. Clean benchmark sheets are not the real world.',
      'Iterative calculation is the part I expected to break, and the fixpoint-loop answer is more reasonable than I assumed.',
      'The collaboration story matters more than raw speed for most teams. If two people edit the same region, does each edit trigger a recompile on both clients?',
      'The best compliment I can give this: I opened the demo sheet and forgot it was compiled until I read the timing panel.',
      'Spill ranges and dynamic arrays seem like the hardest part to compile statically. The shape of the output is only known once the input is.',
      'I ran the demo against {a quarterly close|a headcount planning|an inventory} model from work (sanitised) and got about a {four|six|nine} times speedup on full recalc. Single-cell edits felt the same as before.',
      'Sandboxing is an underrated benefit. A compiled formula cannot reach anything the module does not import, which is a better story than most macro systems have.',
      'The comparison table would be more useful with memory numbers. Spreadsheets that are slow are often also enormous.',
      'Volatile functions remain the enemy. A single NOW() in the wrong place turns an incremental engine into a full-recalc engine.',
      'The debugging story is what I would worry about. When a compiled region gives a surprising answer, how do you step through it?',
      'I was sceptical from the title and the article changed my mind. The architecture section is worth reading even if you never touch spreadsheets.',
      'Someone at my old job built a much cruder version of this in {2015|2017|2019}: formulas translated to generated code, recompiled nightly. It worked, and nobody could maintain it after they left.',
      'Numeric formatting is the other trap. Rounding a displayed value and rounding a stored value are different operations, and users mix them up constantly.',
      'I would pay for this purely for the lookup indexing. Half our workbooks are a lookup against a sorted range that nobody realises is sorted.',
      'The "shared formula" observation is spot on. Most big sheets are the same formula dragged down a column, and treating that as a loop is where the speedup comes from.',
      'A note for anyone evaluating it: test file round-tripping first. An engine that is fast but changes a formula on save is worse than slow.',
      'The post mentions SIMD as future work. For column-shaped formulas that could be another large multiple.',
      'The part I found most interesting was the decision to keep evaluation order strict by default. Reproducibility over speed is the right default for this audience.',
      'This is the kind of project where the last ten percent of compatibility takes ninety percent of the time. Good luck to the author; it is a great start.',
      'Circular references with iterative calc turned on are more common in finance than people think. Every loan schedule I have seen has one.',
      'I would like to see how it handles a sheet with a few hundred named ranges. Name resolution is its own little compiler problem.',
    ],
    replies: [
      'The architecture doc answers that: edits go through the interpreter immediately and the compiled region swaps in when codegen finishes.',
      'Recompile latency is quoted at a few milliseconds for a typical region. The worst case is a region spanning {most of|a large part of|half of} the sheet.',
      'In our models the cross-tab lookups were {seventy|eighty|about ninety} percent of recalc time, so the lookup indexing matters more than the arithmetic.',
      'Date serials are kept as-is, including the 1900 quirk, according to the compatibility notes. Anything else would break existing sheets.',
      'Strict left-to-right summation is the default. The faster mode is opt-in per sheet, and it says so on the sheet.',
      'The module size problem is real. Deduplicating identical formula shapes helps a lot, since most sheets repeat a small number of shapes.',
      'Named ranges are resolved at compile time and recompiled when the name changes. Same mechanism as an edited formula.',
      'Volatile cells are evaluated every recalc regardless, and anything downstream of them is marked dirty. It is the same cost as before, just isolated.',
      'I checked the demo: the dependency view highlights the compiled region when you select a cell. Very nice for explaining slowness to users.',
      'Collaboration is handled by recompiling on each client independently. Codegen is deterministic, so both sides produce the same module.',
      'The file format is unchanged. Compilation is a runtime cache, never saved, which is the right call.',
      'Text functions are all in the interpreter for now. Only numeric formulas compile, per the FAQ.',
      'Iteration caps match the usual defaults: a hundred iterations or a max change of 0.001. Configurable per sheet.',
      'Spill ranges fall back to the interpreter when the output shape changes between recalcs. The compiled path handles the stable-shape case.',
      'Debugging goes through the interpreter: you can force any region back to interpreted mode and step through it there.',
      'The benchmark sheets are linked at the bottom of the post, including one that is deliberately horrible.',
      'Precision matching the interpreter bit for bit is tested on every commit, according to the repo.',
      'A few million cells is where it starts to hurt, mostly from the dependency graph itself rather than the compiled code.',
      'Rounding for display is a formatting concern and never touches the stored double. That separation is at least consistent.',
      'The sandbox point is good. No formula can make a network call, full stop.',
      'That old approach of nightly code generation is exactly what this avoids by keeping the interpreter as the source of truth.',
      'SIMD would help column formulas a lot, but only if the strict-order default is relaxed, which brings back the accountant problem.',
    ],
    questions: [
      'How does it handle a formula that references a whole column?',
      'Does the compiled module get cached between sessions, or rebuilt every time the file opens?',
      'What happens when a user pastes ten thousand rows at once?',
      'Is there a way to see which regions fell back to the interpreter?',
      'How does it treat errors like division by zero propagating through a compiled region?',
      'Does it support user-defined functions, or only the built-in library?',
      'What is the memory overhead of the dependency graph on a large sheet?',
      'Any plans for a server-side mode, for batch recalculation?',
    ],
  },
  postgres: {
    top: [
      'The upgrade notes are worth reading carefully this time. Two of the changed defaults would have bitten us in production.',
      'Every major release I do the same thing: read the release notes, get excited about one feature, and then spend {two|three|four} weeks on the upgrade test plan.',
      'The temporal table support is going to replace a lot of hand-rolled audit triggers, including {about a dozen|several hundred lines|three generations} of ours.',
      'Logical replication getting DDL support is the headline for anyone running blue-green deployments. It removes the most fragile part of our cutover runbook.',
      'I appreciate that the async I/O work is being shipped conservatively. Storage engines are not where you want surprises.',
      'The planner improvements look great in the benchmarks. In practice our biggest wins always come from fixing one bad query someone wrote {years ago|in a hurry|during an incident}.',
      'Managed hosting providers will take {six|nine|twelve} months to offer this, as usual, so most of us are reading these notes for next year.',
      'Vacuum improvements continue to be the least glamorous and most valuable work in this project.',
      'We skipped two major versions and are now planning a jump. pg_upgrade keeping statistics is going to save us an ugly first hour.',
      'The JSON path improvements are nice, but I would rather people stopped storing relational data in JSON columns in the first place.',
      'Partition pruning at execution time has been getting steadily better for years. This release finally makes it good enough for our {billing|event|metrics} tables.',
      'The release cadence of this project is a model for how to run infrastructure software. Predictable, conservative, well documented.',
      'Extension authors are going to have a busy month. The hook changes in this release break at least {two|three|four} extensions we depend on.',
      'Connection handling is still the thing I would change first. A pooler in front is table stakes, and it should not have to be.',
      'I ran our regression suite against the beta over a weekend. {Two|Three|Four} plan changes, all of them improvements, which is a nice surprise.',
      'The monitoring views added in this release are going to make on-call much less painful. Being able to see I/O per query without an extension is huge.',
      'Direct I/O is interesting but I would not turn it on for an existing cluster without a lot of testing.',
      'End of life for the old version lands later this year. If you are still on it, this is the push to move.',
      'The docs for the new merge behaviour are excellent. More projects should write documentation like this.',
      'I have been running this database for {ten|twelve|fifteen} years and the one piece of advice I keep giving is: test your restores, not your backups.',
      'We switched from another database {four|five|six} years ago and every release since has made that decision look better.',
      'The incremental backup support deserves more attention than it is getting in this thread.',
      'Collation changes are the upgrade trap nobody remembers until an index is corrupt. Read that section twice.',
      'Replication slot handling has quietly become much safer over the last few releases. Fewer disks filling up at three in the morning.',
      'Would love a write-up from someone running this at serious scale. Most benchmarks in release threads are from laptops.',
      'The security fixes in the minor releases matter as much as the features in the major one. Patch your minors.',
    ],
    replies: [
      'Agreed on reading the defaults section. The changed checkpoint default alone is worth a test run.',
      'We replay a day of production traffic against the new version before every upgrade. It has caught something every time.',
      'The allowlist for replicated DDL is short but covers the common cases: adding columns and indexes.',
      'pg_upgrade with link mode took about {four|seven|twelve} minutes on our largest cluster. Most of the time was the statistics step, which is now gone.',
      'The audit use case is exactly why temporal tables matter. Just check how table rewrites interact with history before you rely on it.',
      'Managed providers are faster than they used to be. Ours had the previous major within {three|four|five} months.',
      'The extension breakage is usually a recompile. The painful ones are extensions that reach into planner internals.',
      'A pooler is still needed at our scale, but the per-connection memory has come down a lot.',
      'Direct I/O only wins with a much larger buffer cache than the traditional advice. The notes are clear about that.',
      'The new I/O statistics view replaced a homegrown sampling script for us. Nice to delete code.',
      'Restores are the whole game. We test one every week, automatically, and it has failed twice in a year for reasons nobody would have guessed.',
      'JSON columns are fine for truly schemaless data. The problem is when they become the schema.',
      'Partition pruning at execution time made a {two|three|five} times difference on our billing queries with prepared statements.',
      'The collation warning is not theoretical. We had to rebuild {a dozen|twenty|thirty} indexes after an OS upgrade changed the library underneath.',
      'Laptop benchmarks are still useful for spotting regressions. They are just not capacity planning.',
      'Merge has been around for a couple of releases now; this one mostly fixes corner cases in concurrent use.',
      'Incremental backups cut our nightly backup window by about {half|two thirds|three quarters}.',
      'End of life dates are on the versioning page, and they have never slipped in my memory.',
    ],
    questions: [
      'Is anyone running the beta in production yet?',
      'Does the new async I/O work on all platforms, or Linux only?',
      'How long did pg_upgrade take for people with multi-terabyte clusters?',
      'Are there any known plan regressions in the release candidates?',
      'Does logical replication of DDL handle sequences now?',
      'What is the recommended upgrade path from two majors back?',
      'Is there a good tool for comparing query plans between versions?',
    ],
  },
  metal: {
    top: [
      'Our cloud bill was {fourteen|twenty|thirty} percent of revenue before we moved. The single biggest line was egress, which nobody had forecast.',
      'The article is good, but the headline decision only works at a particular size. Below about {twenty|forty|fifty} servers, the ops overhead eats the savings.',
      'We moved to colocation {two|three|four} years ago. The hardware was the easy part. Hiring someone who is comfortable with a failed disk at two in the morning was hard.',
      'Remote hands contracts are the hidden cost in these comparisons. Ours bills per fifteen minutes, and a lost cable run cost more than a month of cloud.',
      'The capacity planning section is the most honest part of the post. You have to buy for the peak and you pay for idle hardware the rest of the year.',
      'Kubernetes on bare metal is much better than it was {five|six|seven} years ago, but load balancing and storage are still where the rough edges are.',
      'The real lock-in in the cloud was never compute. It is managed databases, queues and identity.',
      'Our finance team preferred the cloud because it is opex. Bare metal is capex with depreciation, and that changes how the savings look on paper.',
      'The article mentions a {three|four|five} year hardware refresh. That is where the TCO spreadsheet either works or does not.',
      'One benefit nobody mentions: performance becomes predictable. No noisy neighbours, no surprise throttling, no credits to track.',
      'We did the opposite move and do not regret it. Our workload is spiky, and paying for idle metal made no sense for us.',
      'Network design is where teams moving back underestimate the work. Top of rack switches, BGP, redundant uplinks: it is a discipline of its own.',
      'The migration took us {nine|twelve|eighteen} months, most of it spent untangling services that assumed cloud-specific features.',
      'The best argument in the post is about predictability of cost, not the absolute number. Budgeting became boring again.',
      'Backups and disaster recovery were the part that kept me up at night. Off-site copies, restore drills, a second site: none of it is free.',
      'We kept the cloud for burst capacity and moved the steady-state load to our own hardware. The hybrid setup gave us most of the savings.',
      'The article undersells how much faster modern hardware is. One current server replaced {six|eight|twelve} of our old instances.',
      'IPMI and out-of-band management are essential. If you cannot power cycle a machine from your laptop, you will be driving to the data centre.',
      'Supply chain was the surprise for us. Lead times on servers went from weeks to months during the shortage, and we had no burst option.',
      'The FTE number in the TCO table is the one to argue about. Ours came out lower than expected because the cloud had been eating engineer time too.',
      'Everybody frames this as cloud against metal. Most of the savings in the post came from right-sizing, which you can do anywhere.',
      'Compliance got easier for us after the move. Auditors like being able to walk into a cage and point at the machine.',
      'Security patching is now our problem at every layer: firmware, BMC, OS. That is a real cost and it belongs in the comparison.',
      'I would be curious to see the numbers again after the first hardware failure wave, around year three.',
      'The part about fewer, bigger boxes is the real lesson. Most microservice sprawl exists because instances were small.',
      'Egress pricing is the reason we moved our {video|backup|analytics} workload. The rest stayed where it was.',
      'We tried to calculate the break-even point and it moved every time the cloud provider changed their discount programme.',
      'People forget that owning hardware means owning its end of life too. Disposal, data destruction and resale are all work.',
      'This thread is the same argument every year, and the answer is still: it depends on your workload shape and your team.',
      'What convinced our board was not the savings, it was the multi-year price certainty.',
    ],
    replies: [
      'Egress is always the line item that surprises people. Ours was {a third|forty percent|half} of the bill by the end.',
      'Below a certain scale I agree completely. We were at about {sixty|eighty|a hundred and twenty} servers when the maths flipped.',
      'Remote hands is the right thing to budget for, but a spares shelf in the cage cut our calls by more than half.',
      'Buying for peak is real, but our peak-to-average ratio was only about {1.4|1.6|1.8}, so the idle cost was modest.',
      'Load balancing on metal is solved with a couple of well-understood tools. Storage is the one I would still outsource if I could.',
      'Managed databases were our last dependency too. We moved them eighteen months after the compute.',
      'Depreciation makes the savings look smaller in year one and much bigger in years three to five.',
      'Predictable performance was worth more to us than the cost saving. Our tail latency dropped by half.',
      'Spiky workloads are exactly where the cloud still wins. Nobody should move a batch job that runs one day a month.',
      'We hired one network engineer and it was the best money we spent in the whole migration.',
      'Untangling cloud-specific features is the real migration cost. Queues and object storage were the worst for us.',
      'A second site doubled our DR cost, but we would have paid for multi-region in the cloud anyway.',
      'The hybrid approach is underrated. Keep the elastic parts in the cloud, move the boring parts home.',
      'IPMI saved us more than once. Also put the BMC network on its own switch and never on the internet.',
      'Lead times are better now, but we keep a quarter\'s worth of spare capacity racked and powered off.',
      'The FTE argument cuts both ways. We had a full-time person just managing cloud costs before the move.',
      'Right-sizing is half the story. The other half is that the same money buys much more hardware than it rents.',
      'Firmware patching is the part people forget. We schedule it quarterly and it takes a full day.',
      'Year three is when disks start going. Budget for it and it is a non-event.',
      'Fewer, bigger boxes made our architecture simpler too. Half the services were split only to fit instance sizes.',
    ],
    questions: [
      'What did you do for object storage?',
      'How do you handle hardware failures overnight?',
      'Did you negotiate with your cloud provider before leaving? What did they offer?',
      'How many people are on your infrastructure team now?',
      'Which colocation provider did you use, and how did you choose?',
      'What was your break-even point in months?',
      'Did you keep any workloads in the cloud?',
      'How do you do capacity planning now?',
    ],
  },
  intranet: {
    top: [
      'The intranet at my {first|last|current} job had a page called "Useful links" with {forty|sixty|ninety} entries, and about half of them went nowhere.',
      'The article nails the incentive problem. Launching an intranet gets someone promoted; maintaining one gets nobody anything.',
      'Chat did not kill the intranet, it replaced the hallway. The intranet was already dead; chat just made that obvious.',
      'Our intranet search returned the {2014|2016|2018} version of every policy first. People learned to ask a colleague instead, and then the colleague left.',
      'The org chart page was the only part of our intranet anyone used, and it was wrong about {a quarter|a third|half} of the time.',
      'Every few years a new tool promises to be the single place for company knowledge. Each one becomes one more place.',
      'The best intranet I ever used was a plain wiki maintained by one very stubborn office manager. When she retired, it died within a year.',
      'Content ownership is the whole problem. A page without a named owner is a page that will be wrong within {six|nine|twelve} months.',
      'We tried expiry dates on every page: after a year, the owner had to confirm it was still right. It worked until the owners left.',
      'The fragmentation argument is right. Our knowledge is now split across chat, a wiki, three drive folders and an HR portal, and search spans none of them.',
      'I miss the classifieds page. It was the most human part of the whole company website.',
      'The article is nostalgic about something that was never very good. Intranets were where documents went to be ignored.',
      'Onboarding is where the loss shows. New starters used to have one place to start. Now they have a list of links to other lists of links.',
      'Permissions made our intranet useless. Half of what you needed was on pages you could not see, and nobody knew who could grant access.',
      'The decline of the intranet tracks the decline of the internal communications team. Nobody writes the newsletter any more.',
      'In a {two hundred|five hundred|thousand} person company, an intranet with no gardener has a half-life of about a year.',
      'The piece misses how much of the intranet was compliance theatre. Policies were posted so that someone could say they had been posted.',
      'Ours had a lunch menu for a cafeteria that had been closed for {two|three|five} years. It was the most visited page.',
      'The migration from one intranet platform to the next is where most of the knowledge was lost. Nobody migrates the comments or the history.',
      'The honest replacement for an intranet is a small team whose job is to keep a few pages true. It sounds expensive until you price the alternative.',
      'The article is right that search is the second killer. People do not browse; they search, fail and give up.',
      'Engineering docs survived at our company because they live next to the code. Everything else rotted.',
      'Remote work finished off what was left. The intranet assumed an office, and the office went away.',
    ],
    replies: [
      'Named owners are the only thing I have seen work, and only with a review reminder that actually reaches them.',
      'The retired office manager story is universal. Every working knowledge base has one person holding it up.',
      'Search spanning everything is the product everyone wants and nobody can sell, because permissions make it hard.',
      'Expiry dates worked for us for about {two|three} years, then people started clicking confirm without reading.',
      'Onboarding docs are the canary. If they are wrong, everything else is too.',
      'The classifieds page was ours as well. Sold a bike to someone in legal in {2009|2011|2013}.',
      'The platform migration point is painful and true. We lost ten years of page history in one weekend.',
      'Permissions are the silent killer. We found a whole department\'s process docs visible to nobody but one person.',
      'Docs next to the code survive because the review process touches them. Nothing else in the company has that.',
      'The internal comms team at my company was cut in {2020|2021|2022} and the intranet froze the same month.',
      'Compliance theatre is a real category. Half our policy pages had not been opened by anyone but the author.',
      'A small team keeping a few pages true is exactly right. We did this with two people and it was the best knowledge base I have used.',
      'Remote work made it worse, but the intranet was already a museum by then.',
    ],
    questions: [
      'Has anyone seen an intranet that stayed useful for more than five years?',
      'What did you replace it with, if anything?',
      'Who owned the intranet at your company, IT or communications?',
      'Did anyone try making page owners visible on every page? Did it help?',
      'How do you handle onboarding documentation now?',
    ],
  },
  trackball: {
    top: [
      'I used a trackball for {six|nine|twelve} years of CAD work. What it does better than anything else is small, slow, precise moves, which is most of drafting.',
      'The section on radar plotting consoles is the best part of the piece. It is rare to see input history traced back past the first home computers.',
      'Everyone of a certain age remembers pulling the ball out of a mouse and scraping the rollers clean. A ball mouse is a trackball turned upside down, and the article could have said so.',
      'My mother used a trackball for the last {ten|twelve|fifteen} years of her working life because she could not hold a mouse steady. Accessibility is the quiet reason these devices never died.',
      'Laptop trackballs were a real thing for a few years before touchpads won. I still think the small ones set into the palm rest were the better design.',
      'The claim that trackballs lost to the mouse assumes there is one winner. In control rooms, on ships and in medical imaging they never lost at all.',
      'Big ball, finger operated, on the left of the keyboard. That setup fixed my shoulder pain in about {two|three|six} weeks.',
      'The market is small enough that one manufacturer discontinuing a model is a crisis for the people who use it. I keep {two|three|four} spares in a drawer for that reason.',
      'What surprised me in the article is how early the optical sensing idea appeared. The parts to make it cheap took another thirty years.',
      'The arcade section made me nostalgic. A good bowling cabinet ball had a weight to it that no desk device has ever matched.',
      'I would like a follow-up on the patents. The article hints that a couple of broad ones held the whole category back for a decade.',
      'The ergonomics advice in the piece is fine but generic. The only rule I trust is to change devices before the pain starts, not after.',
      'Ball size matters more than anything else about the device. Anything under about {thirty|thirty-four|forty} millimetres feels twitchy to me.',
      'Trackballs are still standard on ultrasound machines, and it is not nostalgia. You cannot drag a mouse across a cart that is wheeled between rooms all day.',
      'The history is great, but the photos of the early military units are the real treasure. I had never seen the inside of one.',
      'I switched to a trackball for games as a joke and kept it for strategy titles. Anything that rewards precision over speed works well.',
      'Scroll rings were the best idea in the category and most models dropped them. I still do not understand why.',
      'A lot of the "trackballs are niche" framing is really about price. They cost {two|three} times what a comparable mouse costs, because the volumes are small.',
      'The article skips the digitising puck entirely, which is a shame. Engineers went from pucks to trackballs to mice, and each step lost some precision.',
      'I teach an intro hardware class and we take apart a mechanical trackball every year. It is the best single lesson on rotary encoders I know.',
      'Left-handed users are the forgotten market here. Nearly every thumb-operated model is right-handed only.',
      'The durability point is underrated. Mine is {fourteen|seventeen|twenty} years old and on its third cable, and the mechanism has never failed.',
      'Reading this on a laptop with a touchpad, which is in a sense a trackball with the ball taken out.',
      'The piece says trackballs are slower for new users, and the study it links shows the gap closing within {a week|two weeks|a month} of daily use.',
      'The best argument for a trackball is desk space. On a crowded bench, a pointing device that never moves is worth a lot.',
      'Cleaning is still a chore with optical models. The support bearings collect dust and skin oil, only more slowly than the rollers did.',
      'I would love to know how many control rooms still order these new. My guess is more than any consumer maker sells.',
      'The early home computer trackballs were mostly for games, which the article covers well. Office use came much later than I had assumed.',
    ],
    replies: [
      'Finger operated is the key detail. Thumb models mostly move the strain somewhere else.',
      'The console history lives mostly in maintenance manuals, as someone said upthread. A few are scanned and online if you search for the equipment designations.',
      'Ball size really does matter. Going from a small ball to a large one made my cursor feel calm instead of jittery.',
      'Ultrasound carts are a great example. The device has to survive gel, wiping and being bumped into door frames.',
      'Scroll rings went away because they add parts and cost, and most buyers never got to try one in a shop.',
      'The patents point is real. One broad claim on optical ball sensing only expired in the {late nineties|early two thousands}.',
      'Price is volume and nothing else. The parts are cheap; the tooling is spread across very few units.',
      'I keep spares too. The model I use has been discontinued twice and revived once.',
      'Support bearings are the wear item now. Swapping in ceramic ones made mine smoother than new.',
      'The gap closing quickly matches what I saw when our whole team tried them for a month.',
      'Left-handed models exist but you have to look for them, and they are nearly always the finger operated kind.',
      'Arcade balls were solid phenolic, often the same material as billiard balls. That is where the weight came from.',
      'Desk space is exactly why I switched. My bench has a soldering station, a scope and a keyboard, and nowhere to move a mouse.',
      'The puck era deserves its own article. Precision digitising was a whole craft that disappeared almost without comment.',
      'Taking one apart is a great lesson. The slotted wheels and paired sensors explain quadrature better than any diagram.',
      'Laptop trackballs lost because touchpads were thinner, not because they were nicer to use.',
      'Control rooms order them by the crate, as far as I know. Nobody wants a mouse sliding off a console during an incident.',
      'The optical idea was early, but the cheap image sensor is what made it practical. Same story as a lot of hardware.',
      'CAD is where it shines. Slow, precise, repeated moves with no lifting and putting down.',
      'Changing devices before the pain starts is the best advice in this thread.',
      'For people with a tremor, a device that stays still while the hand rests on it is the difference between using a computer and not.',
      'Mine is {nine|eleven|sixteen} years old as well. The switches wore out long before the ball mechanism did.',
    ],
    questions: [
      'Is there a trackball with a proper scroll ring still in production?',
      'Do the large ball models work for people with small hands?',
      'What do control rooms actually use now, trackballs or something else?',
      'Has anyone tried one for photo editing? Curious how it compares with a pen.',
      'Are the optical models any easier to clean than the old roller ones?',
      'How do you set acceleration on a large ball? Mine feels sluggish across a wide screen.',
      'Is the article\'s claim about the first optical design documented anywhere?',
    ],
  },
};

// Handles for the thread's crowd, built from two word lists so the stream's
// regulars and the long tail read alike.
const HANDLE_HEADS = [
  'null', 'byte', 'stack', 'heap', 'loop', 'fold', 'lint', 'cache', 'patch', 'spool', 'queue', 'trace',
  'shard', 'parse', 'kern', 'grep', 'rune', 'glyph', 'nib', 'hex', 'pixel', 'vector', 'delta', 'sigma',
  'scalar', 'tensor', 'mutex', 'fiber', 'socket', 'inode', 'tuple', 'lambda', 'thunk', 'monad', 'slab',
  'ring', 'latch', 'quartz', 'solder', 'relay', 'dipole', 'bezel', 'ferrule', 'grommet', 'sprocket',
];
const HANDLE_TAILS = [
  'wright', 'smith', 'monk', 'hound', 'pilot', 'sage', 'ling', 'ster', 'works', 'field', 'yard', 'craft',
  'bench', 'drift', 'spark', 'wake', 'loft', 'garden', 'shed', 'tide', 'mill', 'reader', 'tinker',
];
const REGULARS = [
  'kernelpanda', 'lambdacurious', 'warmstart', 'offbyfun', 'tokenring', 'staticdrift', 'bitrotting',
  'decimaldrift', 'pagetable', 'planshape', 'vacuumtruck', 'shardbearer', 'depreciator',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const expand = (rand, template) => template.replace(/\{([^}]+)\}/g, (_, group) => pick(rand, group.split('|')));

const ageText = (minutes) => {
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
};
const minutesOf = (age) => {
  const m = /(\d+)\s+(minute|hour|day)/.exec(age);
  return Number(m[1]) * (m[2] === 'day' ? 1440 : m[2] === 'hour' ? 60 : 1);
};

// Live remarks in a tree: a deleted stub is kept for its replies and counts
// for nothing itself.
const liveCount = (list) => list.reduce((n, c) => n + (c.deleted ? 0 : 1) + liveCount(c.replies ?? []), 0);
const nodesOf = (list, depth = 1, out = [], parent = null) => {
  for (const c of list) {
    out.push({ node: c, depth, parent });
    nodesOf(c.replies ?? [], depth + 1, out, c);
  }
  return out;
};

function crowd(rand, n) {
  const handles = new Set(REGULARS);
  while (handles.size < n) {
    const handle = pick(rand, HANDLE_HEADS) + pick(rand, HANDLE_TAILS);
    handles.add(rand() < 0.15 ? handle + Math.floor(rand() * 90 + 10) : handle);
  }
  return [...handles];
}

function writer(rand, topic, used) {
  const unique = (make) => {
    for (let i = 0; i < 40; i++) {
      const text = make();
      if (!used.has(text)) {
        used.add(text);
        return text;
      }
    }
    for (const tail of TAILS) {
      const text = make() + tail;
      if (!used.has(text)) {
        used.add(text);
        return text;
      }
    }
    throw new Error('the pools ran out of distinct remarks');
  };
  const dress = (text) => {
    const roll = rand();
    if (roll < 0.14) return pick(rand, OPENERS) + (/^(?:I\b|[A-Z]{2})/.test(text) ? text : text[0].toLowerCase() + text.slice(1));
    if (roll < 0.26) return text + pick(rand, TAILS);
    return text;
  };
  return {
    root: () =>
      unique(() => {
        const text = dress(expand(rand, pick(rand, topic.top)));
        return rand() < 0.12 ? text + '\n\n' + expand(rand, pick(rand, topic.replies)) : text;
      }),
    reply: () =>
      unique(() => {
        const roll = rand();
        if (roll < 0.42) return dress(expand(rand, pick(rand, topic.replies)));
        if (roll < 0.54) return expand(rand, pick(rand, topic.questions));
        if (roll < 0.86) return expand(rand, pick(rand, GENERIC));
        return pick(rand, SHORT);
      }),
  };
}

// Splits `total` into `parts` whole shares of at least one, heavy-tailed, so a
// few subthreads carry most of the replies.
function shares(rand, total, parts) {
  const weights = Array.from({ length: parts }, () => Math.pow(rand(), 3) + 0.02);
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => 1 + Math.floor(((total - parts) * w) / sum));
  let left = total - out.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % parts, left--) out[i] += 1;
  return out;
}

function buildThread(spec) {
  const rand = mulberry32(spec.id);
  const topic = TOPICS[spec.topic];
  const seeds = structuredClone(SEEDS[spec.id]);
  const used = new Set(nodesOf(seeds).map(({ node }) => node.text));
  const write = writer(rand, topic, used);
  const people = crowd(rand, Math.round(spec.live * 0.45));
  const other = (not) => {
    for (;;) {
      const who = pick(rand, people);
      if (who !== not) return who;
    }
  };
  const remark = (author, minutes, text) => ({ author, age: ageText(minutes), text, replies: [] });
  const replyAge = (parent) => {
    const room = Math.max(0, parent - 2);
    return Math.max(1, parent - 1 - Math.floor(Math.pow(rand(), 1.6) * Math.min(room, 150)));
  };

  // Grows `count` replies under `node`, at most MAX_DEPTH deep. `chain` first
  // runs a single line of replies to the bottom, so the long threads nest as
  // deep as real ones do.
  const grow = (node, depth, minutes, count, chain = false) => {
    if (!count) return;
    if (chain && depth < MAX_DEPTH) {
      const at = replyAge(minutes);
      const child = remark(other(node.author), at, write.reply());
      node.replies.push(child);
      grow(child, depth + 1, at, count - 1, true);
      return;
    }
    const room = depth + 1 >= MAX_DEPTH;
    const fan = room ? count : Math.min(count, 1 + Math.floor(Math.pow(rand(), 1.7) * Math.min(count, 9)));
    const sizes = room ? Array(fan).fill(1) : shares(rand, count, fan);
    for (const size of sizes) {
      const at = replyAge(minutes);
      const author = rand() < 0.2 && node.replyTo ? node.replyTo : other(node.author);
      const child = remark(author, at, write.reply());
      Object.defineProperty(child, 'replyTo', { value: node.author, enumerable: false });
      node.replies.push(child);
      grow(child, depth + 1, at, size - 1);
    }
  };

  const fresh = spec.roots - seeds.length;
  const budget = spec.live - liveCount(seeds);
  const sizes = shares(rand, budget, fresh).sort((a, b) => b - a);
  const roots = sizes.map((size, i) => {
    const minutes = spec.postMinutes - 4 - Math.floor(Math.pow(rand(), 1.3) * (spec.postMinutes - 30));
    const root = remark(other(null), minutes, write.root());
    // The two biggest subthreads each carry one line of replies to the bottom.
    const chain = i < 2 ? Math.min(size - 1, MAX_DEPTH - 1) : 0;
    if (chain) {
      grow(root, 1, minutes, chain, true);
      grow(root, 1, minutes, size - 1 - chain);
    } else {
      grow(root, 1, minutes, size - 1);
    }
    return root;
  });
  // Interleave the new subthreads with the seeds, which keep their order and
  // lead the thread.
  const comments = [];
  const gap = Math.ceil(roots.length / seeds.length);
  seeds.forEach((seed, i) => comments.push(seed, ...roots.slice(i * gap, (i + 1) * gap)));

  // Deleted stubs, kept only where they have replies and never at the top
  // level, as the aggregator keeps them. Each one is replaced by a new reply
  // elsewhere, so the live count stays what the stream states.
  const candidates = nodesOf(roots).filter(({ node, depth }) => depth >= 2 && node.replies.length);
  const stubs = Math.max(2, Math.round(candidates.length * 0.05));
  for (let i = 0; i < stubs && candidates.length; i++) {
    const [{ node, parent }] = candidates.splice(Math.floor(rand() * candidates.length), 1);
    if (parent?.deleted || node.replies.some((r) => r.deleted)) {
      i -= 1;
      continue;
    }
    for (const key of ['author', 'age', 'text']) delete node[key];
    node.deleted = true;
    const hosts = nodesOf(roots).filter(({ node: n, depth }) => !n.deleted && depth < MAX_DEPTH);
    const { node: host } = pick(rand, hosts);
    host.replies.push(remark(other(host.author), replyAge(minutesOf(host.age)), write.reply()));
  }

  const nodes = nodesOf(comments);
  const depth = Math.max(...nodes.map((n) => n.depth));
  if (liveCount(comments) !== spec.live) throw new Error(`${spec.id}: ${liveCount(comments)} live, not ${spec.live}`);
  if (comments.length !== spec.roots) throw new Error(`${spec.id}: ${comments.length} top-level, not ${spec.roots}`);
  if (depth < 6 || depth > MAX_DEPTH) throw new Error(`${spec.id}: nests ${depth} deep`);
  if (comments.some((c) => c.deleted)) throw new Error(`${spec.id}: a top-level comment is a stub`);
  if (!nodes.some(({ node }) => (node.replies ?? []).length > 4)) throw new Error(`${spec.id}: no reply list long enough to fold`);
  return { id: spec.id, comments };
}

// Minutes before the stream's "now" each post was submitted, as its row says.
const THREADS = [
  { id: 41722351, topic: 'spreadsheet', live: 287, roots: 38, postMinutes: 600 },
  { id: 41723663, topic: 'postgres', live: 214, roots: 29, postMinutes: 540 },
  { id: 41718514, topic: 'trackball', live: 193, roots: 27, postMinutes: 780 },
  { id: 41721076, topic: 'metal', live: 356, roots: 44, postMinutes: 660 },
  { id: 41716829, topic: 'intranet', live: 168, roots: 26, postMinutes: 840 },
];

for (const spec of THREADS) {
  const thread = buildThread(spec);
  await writeFile(join(THREADS_DIR, `${spec.id}.json`), JSON.stringify(thread, null, 1) + '\n');
}

// Every stream row's reply count, restated from its thread file.
const files = new Set(await readdir(THREADS_DIR));
for (const name of ['items.json', 'items2.json']) {
  const path = join(NEWS, name);
  const items = JSON.parse(await readFile(path, 'utf8'));
  for (const item of items) {
    if (item.type === 'job') continue;
    const file = `${item.id}.json`;
    item.comments = files.has(file)
      ? liveCount(JSON.parse(await readFile(join(THREADS_DIR, file), 'utf8')).comments)
      : 0;
  }
  await writeFile(path, JSON.stringify(items, null, 1) + '\n');
}
