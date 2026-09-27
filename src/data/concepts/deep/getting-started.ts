import type { DepthMap } from './types';

export const gettingStartedDepth: DepthMap = {
  'what-is-system-design': {
    analogy: {
      title: 'Designing a restaurant, not cooking a dish',
      body:
        'A cook worries about one plate: the right ingredients, the right heat, the right time. A restaurant designer worries about four hundred plates on a Friday night: how many stoves, where the fridge goes, what happens when the dishwasher breaks, how orders reach the kitchen without being lost. System design is the second job. The recipes (your code) matter, but the layout decides whether Friday night works.',
    },
    deepDive: [
      {
        heading: 'Coding answers "does it work?", design answers "does it keep working?"',
        paragraphs: [
          'When you write a function you are asking one question: given this input, do I get the right output? That question has a clean answer, and a unit test can check it. System design asks a different set of questions, and none of them can be answered by reading a function body.',
          'Those questions are always about the edges: what happens at a thousand times the traffic, what happens when a machine disappears mid-request, what happens when two servers hold different answers to the same question. A perfectly correct function still produces an outage if it runs on one machine and that machine reboots.',
          'This is why design work feels vague at first. There is no compiler telling you the answer is wrong. The only feedback is a number - latency, availability, cost - and a number only exists once somebody has written the requirement down.',
        ],
        bullets: [
          'Code question: is the output correct for this input?',
          'Design question: is the system still correct at 100x load, with a dead node, and under a network partition?',
          'A design is "right" only relative to requirements. Change the requirements and the same diagram becomes wrong.',
        ],
      },
      {
        heading: 'The loop: there is always exactly one bottleneck that matters',
        paragraphs: [
          'Beginners try to design the whole system at once and freeze, because everything seems to depend on everything. Experienced engineers use a loop instead, and the loop is short: start with the simplest thing that could work, find what breaks first, fix only that, then name the new problem you just created.',
          'The reason this works is that systems fail in sequence, not all at once. If the database saturates at 500 writes per second, nothing else about the design matters until that is handled - adding a message queue for a feature that runs at 5 requests per second is invisible work. Fix the first bottleneck and the next one reveals itself; you never have to predict all of them in advance.',
          'The second half of the loop is the part people skip. Every component you add is also a component that can fail, needs monitoring, and has to be deployed. A cache introduces stale data. A queue introduces out-of-order processing. Saying the cost out loud is what stops an architecture from quietly growing to twenty boxes nobody can operate.',
        ],
        code: {
          caption: 'The loop, drawn once',
          body: `simplest design that could work
        |
   run it / estimate it
        |
   what saturates first?   <-- exactly one thing
        |
   add ONE component to relieve it
        |
   name the new cost it introduces
        |
   is the remaining risk acceptable?  -- no --> repeat`,
        },
      },
      {
        heading: 'Why "it depends" is a real answer (and how to make it useful)',
        paragraphs: [
          'Almost every system design question has the answer "it depends", and juniors hear that as evasion. It is not. It means the correct choice is a function of inputs that have not been stated yet: read/write ratio, tolerable staleness, budget, team size, how bad an outage is.',
          'The professional move is to not stop at "it depends" but to say what it depends on. "SQL or NoSQL?" becomes "if the access pattern is one known key and we need 50k writes per second, a key-value store; if analysts will write ad-hoc joins across five entities, Postgres." Now the conversation is about facts, not preferences.',
          'This is also why system design interviews score the process rather than the diagram. Two candidates can draw the same boxes; the one who says "I am choosing eventual consistency here because a like count being one second stale is harmless, but I would not do this for account balances" is the one who understands the design.',
        ],
      },
    ],
    examples: [
      {
        title: 'Growing Instagram, one bottleneck at a time',
        setup:
          'Instagram must let people upload a photo, view a home feed, follow accounts and like. Each daily user sends about 30 requests a day, 5% of them writes, and the busiest hour runs at 5 times the daily average. The limits are round planning numbers: 1,000 requests/s for one app server, 10,000 reads/s for one database copy, 10,000 writes/s for one primary. This is the loop the Lab runs, from 100k to 200M daily users.',
        walkthrough: [
          'Simplest design at 100k daily users: 100,000 x 30 / 86,400 s x 5 is about 174 requests/s at peak. One App server and one Database carry it with room to spare. Monthly cost x1.',
          'Round 1, 1M daily users: 1,736 requests/s at peak, and one App server handles 1,000, so the App server is the bottleneck. Three fixes: more servers behind a load balancer (x1 to x1.4, every server must be stateless), an autoscaling pool (x1.2, a spike waits for new servers) or one 8x machine (x2.7, still one server and no bigger size). Pick the load balancer: 3 app servers.',
          'Round 2, 10M daily users: 27 app servers carry 17,361 requests/s, but 95% of them are feed reads - 16,493 reads/s against 10,000 for one database copy. The Database is the bottleneck. A cache that answers 80% of reads leaves 3,299 reads/s for it and adds x0.2 (x5.3 in all). Its cost: a slightly stale feed.',
          'Round 3, 200M daily users: 329,861 reads/s at peak, and after the cache 65,972 still reach the Database - the cache bought one round, not three. Six read replicas share them (7 copies, +x2.8). Their cost: replica lag, so you may not see your own post for a moment.',
          'Still round 3: writes are 5% of 347,222 requests/s, so 17,361 writes/s against 10,000 for one primary. Split the writes into 2 partitions (+x0.5). Their cost: a feed that spans partitions must read them all, and the partition key is hard to change later.',
        ],
        result:
          'Three rounds, four bottlenecks, each found by a number and fixed with one component whose cost was named. At 200M daily users nothing is over its limit and the bill is about x85 the simplest design - and 522 app servers are most of it: the price of the users, not of the fixes.',
      },
    ],
    jargon: [
      { term: 'Architecture', plain: 'The set of decisions that are expensive to change later - where state lives, how services talk, how data is partitioned.' },
      { term: 'Bottleneck', plain: 'The one resource that saturates first and therefore caps the whole system. Everything else has spare capacity by definition.' },
      { term: 'Trade-off', plain: 'A choice where you gain one property by paying with another. If a choice has no cost, it is not a trade-off, it is just a better option.' },
      { term: 'Requirement', plain: 'A statement about what the system must do or how well, ideally with a number attached so you can tell when you are done.' },
      { term: 'Over-engineering', plain: 'Complexity that no requirement pays for. It costs real money every day in operations, so it is a bug, not caution.' },
    ],
    remember: [
      'Design is the set of decisions that are hard to undo; everything else is just code you can rewrite.',
      'Start with the simplest thing that works, then fix exactly one bottleneck at a time.',
      'Every component you add solves one problem and creates another - say the new one out loud.',
      'A fix that multiplies capacity (a cache, a bigger machine) buys a round; one that grows with the load (servers, replicas, partitions) keeps up, at a price.',
      'Requirements justify architecture. If no number forces a component, delete it.',
    ],
  },

  'functional-requirements': {
    analogy: {
      title: 'The menu, not the kitchen',
      body:
        'Functional requirements are the menu a customer reads: "grilled salmon", "chocolate cake". They say what can be ordered, in words a customer understands. How hot the grill runs, how many chefs are on shift and how fast the food arrives are different questions entirely. Write the menu first - the kitchen layout follows from it, never the other way round.',
    },
    deepDive: [
      {
        heading: 'A good functional requirement is a sentence a user could say',
        paragraphs: [
          'The reliable test is this: can you phrase it as "a <role> can <action> so that <outcome>"? "A user can send a message to a group" passes. "We will use WebSockets" fails - that is a solution, not a requirement. "The app must be fast" also fails, because no user action is described; that is a non-functional requirement wearing the wrong hat.',
          'Keeping requirements in user language matters because it keeps the design honest. Once you write "we need Kafka" in the requirements list, nobody ever asks whether Kafka is needed - it has been smuggled in as a given. Written as "a user can see their feed update within a second", the transport is still an open decision.',
          'Each requirement should also be small enough to argue about. "Support social features" is not a requirement, it is a category. Break it into follow a user, unfollow a user, see a feed of followed users, and suddenly you can see which ones are expensive.',
        ],
        bullets: [
          'Good: "A user can upload a photo up to 25 MB and see it in their profile."',
          'Bad: "The system supports media." (too vague to design against)',
          'Bad: "Photos are stored in S3." (an implementation decision, decide it later)',
          'Bad: "Uploads are fast." (non-functional - belongs in the NFR list with a number)',
        ],
      },
      {
        heading: 'Requirements drive the data model, and the data model drives everything else',
        paragraphs: [
          'The most useful thing you can do with each requirement is ask two questions: what does it read, and what does it write? That single habit converts a feature list into an architecture, because reads and writes are what components are built to serve.',
          '"A user can see a feed of posts from people they follow" reads a followers table and a posts table, and it is read-heavy. That immediately suggests caching, denormalisation, maybe fan-out on write. "A user can delete their account and all their data" writes across every table in the system, and it is what makes cascading deletes and GDPR exports part of your design rather than a surprise in year two.',
          'This is also why the unglamorous requirements matter so much. Search, delete, export and edit history are the ones that break naive data models. Teams that only list the happy-path features end up rebuilding the storage layer once the first legal request arrives.',
        ],
      },
      {
        heading: 'Scoping in an interview (and in a sprint planning meeting)',
        paragraphs: [
          'When somebody says "design Twitter", they have not given you requirements - they have given you a brand name. The expected first move is to propose a scope and get agreement: "I will cover posting a tweet, following a user and reading a home timeline. I will leave out DMs, ads and search unless you want them." That takes thirty seconds and it saves the entire rest of the conversation.',
          'Be explicit about what is out of scope, not just what is in. An unlisted feature is an assumed feature; the interviewer or the product owner is quietly holding one in their head and will mention it at the worst moment. Naming the exclusions makes them negotiable.',
          'Then rank what is in scope. Usually two or three core flows account for most of the traffic and nearly all of the architectural pressure. Design for those; everything else rides on the same infrastructure.',
        ],
      },
    ],
    examples: [
      {
        title: 'Turning "design WhatsApp" into a design',
        setup: 'You are given two words. Here is how to turn them into parts you can draw, each with a reason - the same picture the Requirements Lab opens on for this Concept.',
        walkthrough: [
          'List candidate features in user language - 7 of them: send messages, receive messages live, group conversations, delivery and read receipts, send images, voice and video calls, stories.',
          'Pick the core 4: send, receive live, groups and receipts. Say the other 3 out loud as out of scope: images, calls and stories.',
          'Annotate reads and writes at 1,000 daily users: 20 requests each is 20,000 a day, 10% of them writes, so 2,000 messages stored a day. At a peak of 5x the average that is about 1 request a second - one App server and one Database carry it.',
          'Map each core feature to the part it forces: send needs an App server and a Database; receiving live needs a WebSocket server holding about 100 connections open (10% of users online at peak); groups need Queue + workers, so a message to a group of 20 becomes 20 deliveries; receipts add no box but make 3 pushes per message.',
          'Name what the 3 cut features would have added: calls need Media servers, a separate system that relays voice and video; images and stories need Object storage and a CDN. That is 3 parts not built.',
        ],
        result:
          'Four sentences of scope produced 4 parts, each named by the feature that forced it, and kept 3 more - Media servers, Object storage and a CDN - off the bill, before a single technology was argued about.',
      },
    ],
    jargon: [
      { term: 'Functional requirement', plain: 'Something a user can do, observable from outside the system.' },
      { term: 'Scope', plain: 'The agreed list of what you are building now. Everything not on it is out, and saying so is the point.' },
      { term: 'Core flow', plain: 'The two or three actions that generate most of the traffic and therefore most of the design pressure.' },
      { term: 'Access pattern', plain: 'Which data a feature reads and writes, and how often. This is what actually picks your database.' },
      { term: 'Scope creep', plain: 'Requirements that get added quietly after the design was sized for a smaller list.' },
    ],
    remember: [
      'Write requirements as "a user can ..." - if you cannot, it is not a functional requirement.',
      'Technology names in a requirements list are decisions smuggled in without debate.',
      'For each requirement ask: what does it read, what does it write, how often?',
      'State what is out of scope. Unlisted features are assumed features.',
    ],
  },

  'non-functional-requirements': {
    analogy: {
      title: 'Buying a car by the spec sheet',
      body:
        'Every car does the same functional thing: it drives. The spec sheet is where the real differences live - top speed, fuel consumption, crash rating, service interval, price. Nobody buys a car on "it drives"; they buy on the numbers. Non-functional requirements are the spec sheet of your system, and like a car, you cannot have the fastest, cheapest and safest one all at once.',
    },
    deepDive: [
      {
        heading: 'NFRs are what actually force architecture',
        paragraphs: [
          'Take two systems with an identical feature list: a personal blog and a hospital records system. Both store documents, both let a user read and write them. One runs on a five dollar virtual machine; the other runs multi-region with synchronous replication, audit logs and a documented recovery procedure. The features did not cause that difference - the availability, durability and compliance numbers did.',
          'This is the single most useful idea for a junior engineer to internalise, because it explains why "how would you design X" questions never have one answer. Until somebody states the availability target and the tolerable staleness, every architecture is equally defensible.',
          'It also explains why copying the architecture of a big company goes wrong. Netflix built for a set of numbers - hundreds of millions of streams, multi-region failure tolerance - that your internal tool does not have. The architecture is the answer to their spec sheet, not yours.',
        ],
        bullets: [
          'Availability: what fraction of the time does it answer? Expressed in nines.',
          'Latency: how long does one request take? Always stated at a percentile, never as an average.',
          'Throughput: how many requests per second, at peak, not on average.',
          'Consistency: how stale may a read be? Often different per operation.',
          'Durability: how much committed data may be lost? For most systems the answer is none.',
          'Cost and operability: what is the monthly bill, and who gets paged at 3am?',
        ],
      },
      {
        heading: 'Why percentiles, and never averages',
        paragraphs: [
          'Imagine 100 requests: 99 take 50 ms and one takes 5 seconds. The average is 99 ms, which looks fine on a dashboard. But one user in a hundred waited five seconds, and if a page makes 20 such calls, nearly one page load in five contains at least one of them. Averages hide exactly the users who are having a bad time.',
          'So latency is stated as p95 or p99: "p99 under 300 ms" means 99 out of 100 requests finish within 300 ms. The tail is where retries, garbage collection pauses, cold caches and overloaded shards show up, which is why engineers care about it more than the median.',
          'A practical rule: the more calls a single user action makes, the more the tail dominates. With 20 backend calls per page and a p99 of 1 second, roughly one in five page loads will hit that 1 second call. Tail latency is not an edge case at scale - it is the common case.',
        ],
        code: {
          caption: 'Availability targets, in time you can picture',
          body: `Target      Downtime/year   Downtime/month   Feels like
99%         3.65 days       7.2 hours        a hobby project
99.9%       8.8 hours       43 minutes       one bad deploy a month
99.99%      52 minutes      4.3 minutes      needs automated failover
99.999%     5.3 minutes     26 seconds       no human can react in time`,
        },
      },
      {
        heading: 'NFRs pull against each other - decide which one loses',
        paragraphs: [
          'The hard part is not writing the numbers down, it is that several of them are in direct conflict. Strong consistency across regions costs a network round trip, which costs latency. High availability during a network partition requires serving possibly stale data, which costs consistency. Lower cost means less redundancy, which costs availability.',
          'A useful design document therefore does not just list targets, it states the priority order and what gives way. "If consistency and availability conflict during a partition, we choose availability for the feed and consistency for payments" is a sentence that prevents a year of argument, and it is exactly the sentence CAP is trying to make you write.',
          'Specify consistency per operation, not per system. Almost every real product has both kinds: a like counter that may be a few seconds stale, and a balance transfer that may not be wrong for a microsecond. Teams that pick one global setting end up either too slow or subtly incorrect.',
        ],
      },
    ],
    examples: [
      {
        title: 'What "99.99% for ride requests" commits Uber to',
        setup:
          'Uber with its core features - drivers publish their location, riders request a ride and are matched, the trip is tracked live, payment is automatic - at 1k daily users and 99%. The Requirements Lab draws one copy of each part: App server, WebSocket server, Database, Geo index, Queue + workers. It bills 8.5 units a month (one app server = 1) and calls that x1. A ride request that fails is a rider who opens another app, so the target is 99.99%. Here is what the Lab draws on the way there.',
        walkthrough: [
          '99.99% of a year is 52 minutes of allowed downtime (525,600 minutes x 0.0001). That is the whole budget for the year, deploys included.',
          'At 99% the Lab shows five single points: the app server, the WebSocket server, the database, the geo index and the queue + workers. One failure noticed and fixed by hand in 15 minutes uses 29 percent of the 52-minute budget, so a single copy of anything cannot stay.',
          '99.9% draws redundant instances: App servers x2 and WebSocket x2 behind a Load balancer x2 that health-checks each server and skips a dead one. The load is about 32 requests a second, which one server carries, so the stat row reads 1 for load, +1 for 99.9%. The database, the geo index and the queue + workers are still one copy each: 3 single points. The bill goes from x1 to x1.3.',
          '99.99% draws multi-zone: region 1 now runs in 3 zones, with one copy of each server tier in every zone - App servers x3 and WebSocket x3, 1 for load, +2 for 99.99%, and Geo index x3 and Queue + workers x3. Losing a whole zone still leaves 2 of the 3 copies serving.',
          'It also draws automated failover: a failover done by a human takes 15 minutes or more, so the Database becomes Database x2 - a standby copy, promoted automatically when the primary dies. Single points: 5 at 99%, 3 at 99.9%, 0 now.',
          'The bill: 3 app servers (3) + 3 WebSocket servers (3) + 2 database copies (2 x 3 = 6) + the load balancer pair (0.6) + 3 Queue + workers (3 x 1.5 = 4.5) + 3 Geo index copies (3 x 2 = 6) = 23.1, plus 10% for the traffic between the 3 zones = 25.4 units. 25.4 / 8.5 is x3.',
        ],
        result:
          'Four nines for ride requests turned into a load balancer pair, a copy of every tier - geo index and queue included - in each of 3 zones and a database standby promoted automatically - and the monthly bill went from x1 to x3 in the model, the top of the 2-3x rule of thumb, because almost every part now runs three times. None of it was a configuration flag, which is exactly the honest answer to give a product owner.',
      },
    ],
    jargon: [
      { term: 'Nines', plain: 'Shorthand for availability. "Four nines" means 99.99% uptime, about 52 minutes of downtime per year.' },
      { term: 'p95 / p99', plain: 'The latency that 95% (or 99%) of requests come in under. The slow tail that averages hide.' },
      { term: 'Tail latency', plain: 'The slowest few percent of requests. A page that makes many calls hits it far more often than any single call does.' },
      { term: 'Durability', plain: 'The promise that data already acknowledged as written will not be lost, even if machines die.' },
      { term: 'RPO / RTO', plain: 'How much data you may lose in a disaster (Recovery Point) and how long recovery may take (Recovery Time).' },
      { term: 'Operability', plain: 'How easy the system is to run: deploy, debug, page someone, recover. Rarely written down, always paid for.' },
    ],
    remember: [
      'Features decide what you build; NFRs decide how you have to build it.',
      'Always attach a number. "Fast" and "reliable" are not requirements.',
      'Measure latency at p95/p99 - averages hide the users having a bad day.',
      'Each extra nine roughly multiplies both the machinery and the bill.',
      'State which NFR loses when two conflict, before the incident forces the answer.',
    ],
  },

  'capacity-estimation': {
    analogy: {
      title: 'Catering for a wedding',
      body:
        'Before you rent a venue you ask: how many guests, how many plates each, how much food per plate? You do not need to know whether Aunt Maria takes two bread rolls or three. You need to know whether you are cooking for 50 people or 500, because that decides the kitchen, the staff and the budget. Capacity estimation is that arithmetic for servers, and it is deliberately rough.',
    },
    deepDive: [
      {
        heading: 'The four numbers you are always computing',
        paragraphs: [
          'Every capacity estimate, no matter the product, comes down to the same four outputs: requests per second at peak, storage growth per year, bandwidth per second, and memory needed for the hot working set. Everything else in the estimate exists to produce those four.',
          'The inputs are equally standard: daily active users, actions per user per day, the read/write ratio, and the average size of one object. If you can get those four inputs out of a product owner, you can size a system in about three minutes on a whiteboard.',
          'The order matters too. Compute the average rate first, then apply a peak factor, and only then compare the result to what one machine can do. That comparison is the whole point of the exercise - it is how you find out whether this is a laptop-sized problem or a fleet-sized problem.',
        ],
        code: {
          caption: 'The template, memorise the shape not the numbers',
          body: `requests/day   = DAU x actions per user per day
avg req/sec    = requests/day / 86,400        (call it 100k)
peak req/sec   = avg x peak factor            (2x to 10x)

writes/sec     = peak req/sec x write share
storage/day    = writes/day x bytes per object
storage/year   = storage/day x 365            (one copy)
kept           = storage/year x retention years
stored         = kept x replication factor    (what you pay for)

bandwidth      = req/sec x avg response bytes
hot set in RAM = active objects x bytes per object`,
        },
      },
      {
        heading: 'Peak factor: the number juniors forget and then get paged for',
        paragraphs: [
          'Traffic is never flat. A consumer app in one country might do 60 percent of its daily traffic in four evening hours; a B2B tool does almost everything in office hours; a sports app does 50x its baseline for ninety minutes. Dividing daily requests by 86,400 gives you the average second, and the average second never happens.',
          'So multiply by a peak factor. Use 2x for a global service with traffic spread across time zones, 3-5x for a single-region consumer app, and 10x or more for anything with scheduled events, marketing pushes or cron jobs that fire on the hour. If you have real data, use the ratio of the busiest hour to the average hour.',
          'The classic self-inflicted spike is worth knowing: every client retrying at exactly the top of the minute, or every cache expiring at the same second. Those turn a smooth load into a 20x spike that no capacity plan covers - which is why jitter and staggered expiry exist.',
        ],
      },
      {
        heading: 'Round aggressively, then sanity-check against one machine',
        paragraphs: [
          'Use 100,000 seconds for a day instead of 86,400, round the big inputs (users, requests, bytes) to powers of ten and the small factors to one significant figure. The estimate is not trying to be accurate; it is trying to answer "which order of magnitude is this?" Getting 11,574 req/sec instead of 10,000 req/sec changes no decision you will make today.',
          'The decision you are actually making is a category. Under roughly 1,000 requests per second, one well-tuned machine plus a spare is usually enough and the interesting problems are elsewhere. That boundary comes from a common planning number: about 1,000 requests per second per app server when each request does real work, such as a database call. A server returning cached or static answers can do ten times more, so say which one you assumed. Between 1,000 and 50,000 you need horizontal scaling, caching and a serious look at the database. Above that, partitioning and per-region deployment stop being optional.',
          'Storage has the same categories. Under a terabyte, a single database instance is fine for years. Tens of terabytes means partitioning, archival tiers and a real retention policy. Do the multiplication before choosing, because "how much data per year" is the question that decides whether sharding is in your future.',
        ],
        bullets: [
          '1 KB x 1M/day is about 1 GB/day, about 365 GB/year - one machine, no problem.',
          '1 MB x 1M/day is about 1 TB/day, about 365 TB/year - object storage and a retention policy.',
          'Per year is one copy. Multiply it by the years you keep the data, then by the replication factor: 3 copies means 3 times the bill.',
        ],
      },
    ],
    examples: [
      {
        title: 'Sizing a chat app end to end',
        setup:
          'A messaging app with 10 million daily active users, each sending 40 messages per day and reading roughly 4x what they send. Average message 200 bytes, plus metadata call it 500 bytes stored. Messages are kept 5 years, in 3 copies. To replay it in the Lab: 200 requests per user, 20% writes, 0.5 KB, peak factor 4.',
        walkthrough: [
          'Writes per day: 10M x 40 = 400M messages. Divided by 86,400, that is about 4,600 writes per second on average.',
          'Reads per day: 4x writes = 1.6B, about 18,500 reads per second on average.',
          'Peak factor for a single-region consumer app, evening heavy: use 4x. Peak is about 18,500 writes/sec and 74,000 reads/sec.',
          'Storage per day: 400M x 500 bytes is 200 GB. Per year, one copy: times 365 is 73 TB.',
          'Retention, then replication: 5 years kept is 365 TB, and 3 copies of it is about 1.1 PB stored.',
          'App tier: about 92,500 peak requests/sec in total, at 1,000 per server, is 93 servers; with 50% headroom call it 140.',
          'Bandwidth on reads: 74,000/sec x 500 bytes is about 37 MB/sec, roughly 300 Mbit/sec - comfortable for a fleet, impossible to ignore for one box.',
          'Hot set: messages from the last day are what people actually re-read. 200 GB does not fit in one cache node, so the cache is either sharded or holds only the last hours of conversations.',
        ],
        result:
          '74,000 peak reads per second, 18,500 peak writes per second (past one primary) and 1.1 PB after 5 years is firmly in "partition the data, cache aggressively, many app servers" territory. Ten minutes of arithmetic ruled out the single-database design before anyone wrote code.',
      },
    ],
    jargon: [
      { term: 'DAU / MAU', plain: 'Daily and monthly active users. The starting input for almost every estimate.' },
      { term: 'QPS / RPS', plain: 'Queries (or requests) per second. The main unit of load.' },
      { term: 'Peak factor', plain: 'How much busier the busiest moment is than the average. Typically 2x to 10x.' },
      { term: 'Read/write ratio', plain: 'How many reads happen per write. Decides whether caching and replicas will help at all.' },
      { term: 'Working set', plain: 'The slice of data actually being touched right now. If it fits in RAM, your system feels fast.' },
      { term: 'Replication factor', plain: 'How many copies of each byte you keep. The last storage step: multiply the storage you retain by it.' },
    ],
    remember: [
      'A day is about 100,000 seconds. That one rounding does most of the work.',
      'Average load never happens - multiply by a peak factor of 2x to 10x.',
      'Estimates pick a category (one machine, a fleet, a partitioned fleet), not an exact number.',
      'Storage in three steps: per day x 365 is one year (one copy), x retention years is what you keep, x copies is what you store.',
      'If reads hugely outnumber writes, caching and replicas will help. If not, they will not.',
    ],
  },

  'back-of-the-envelope': {
    analogy: {
      title: 'Knowing that a bus is slower than a plane',
      body:
        'You do not need a timetable to know that flying from Bucharest to Paris beats taking a bus - the orders of magnitude are obvious, so you reject the bus in one second. Latency numbers do the same job for software: memory is nanoseconds, disk is microseconds to milliseconds, a cross-continent round trip is a tenth of a second. Once those ratios are in your head, bad designs become obviously bad without any measurement.',
    },
    deepDive: [
      {
        heading: 'Learn the ratios, not the values',
        paragraphs: [
          'Hardware changes: SSDs get faster, networks get better, the absolute numbers drift every few years. What barely changes is the distance between the levels. Memory is roughly a thousand times faster than an SSD read, an SSD read is roughly a hundred times faster than a spinning disk seek, and a trip across the Atlantic is slower than everything because it is limited by physics, not engineering.',
          'Those ratios are the whole toolkit. "This design reads from disk inside a request that has a 100 ms budget, 50 times" becomes an obvious no once you know a random SSD read is about 100 microseconds - 50 of them is 5 ms, fine - but a spinning-disk seek is 10 ms, and 50 of those is half a second, which is not fine.',
          'The number that beats all the others is the cross-region round trip. Light in fibre travels roughly 200 km per millisecond, and the path is never straight, so a round trip between London and New York takes about 70-80 ms in practice. No amount of engineering will make a synchronous cross-continent write feel local. That single fact explains read replicas, CDNs and eventual consistency.',
        ],
        code: {
          caption: 'The canonical list, rounded to orders of magnitude',
          body: `L1 cache reference              ~1 ns
Main memory reference         ~100 ns    100x an L1 reference
SSD random read               ~100 us    1,000x a memory reference
Round trip in the same DC     ~500 us    5x an SSD read
Spinning disk seek             ~10 ms    100x an SSD read
Round trip US West <-> EU     ~150 ms    300x a round trip in the DC

Useful conversions
1 ms = 1,000 us = 1,000,000 ns
1 day ~= 86,400 s ~= 10^5 s
1 year ~= 31.5M s ~= 3 x 10^7 s`,
        },
      },
      {
        heading: 'Scaling the numbers to human time',
        paragraphs: [
          'Nanoseconds are impossible to feel, so translate the whole table by a factor of a billion and it becomes a workday. If an L1 cache reference takes 1 second, then main memory takes about 2 minutes, an SSD read takes a little over a day, a datacenter round trip takes about a week, and a round trip from Europe to the US takes about 5 years.',
          'Hold that picture during design reviews. "We will just call the other service" is a week-long errand in this scale. "We will call it in a loop, once per item, for 200 items" is four years of errands. That is why batching and N+1 queries matter so much more than micro-optimising the code inside the loop.',
          'The practical consequence: the biggest performance wins are almost always about removing round trips, not making code faster. Batch the queries, cache the result, move the data closer, or do the work asynchronously. Optimising an O(n) loop that runs entirely in memory is usually noise next to one avoidable network call.',
        ],
      },
      {
        heading: 'Three habits that make estimates fast',
        paragraphs: [
          'First, always compare to one machine. A modern server handles on the order of tens of thousands of trivial requests per second (static or cached answers) - closer to a thousand when each request does real work - holds hundreds of gigabytes of RAM, and pushes gigabits of network. If your estimate lands far below that, stop designing a distributed system.',
          'Second, convert everything to per-second before comparing. Different people quote per-day, per-month or per-hour numbers and they are not comparable until normalised. Per-second against machine capability is the only comparison that produces a decision.',
          'Third, write the powers of ten. Thinking in 10^5 and 10^9 instead of 86,400 and 1,073,741,824 removes arithmetic mistakes under pressure, and multiplying becomes adding exponents: 10^7 users x 10 requests is 10^8 a day, and 10^8 / 10^5 seconds is 10^3 per second. Nobody has ever made a worse architectural decision because they used 1000 instead of 1024.',
          'Each rounding to a power of ten can be off by up to about 3x. When some inputs round up and others round down the errors cancel; when they all round the same way they multiply. So a rough answer is trusted to pick the order of magnitude, and when it lands right on a boundary between two designs, you redo it exactly.',
        ],
        bullets: [
          '1 KB = 10^3 bytes, 1 MB = 10^6, 1 GB = 10^9, 1 TB = 10^12.',
          'One machine: roughly 10k-100k trivial req/sec (about 1k doing real work), 100s of GB RAM, 1-10 Gbit/sec network.',
          '1 Gbit/sec is about 125 MB/sec. Divide bits by 8 before comparing with file sizes.',
        ],
      },
    ],
    examples: [
      {
        title: 'Rejecting a design in fifteen seconds',
        setup:
          'A teammate proposes: for each item in the cart, call the pricing service to get the current price. Carts average 30 items, the pricing service lives in another region, and the page has a 500 ms budget.',
        walkthrough: [
          'One cross-region round trip: about 150 ms. That is the floor, before the service does any work.',
          'Sequential calls: 30 x 150 ms = 4,500 ms. Nine times over budget - rejected immediately, no benchmark needed.',
          'Parallel calls: still about 150-200 ms for the slowest one, plus tail latency, plus 30 concurrent connections per user against the pricing service. Technically within budget, but the p99 will be much worse and the connection count explodes at scale.',
          'Batched call: one request carrying 30 item ids. One round trip, about 150 ms, one connection. Same data, 30x fewer trips.',
          'Better still: co-locate or cache. Prices change rarely, so a local cache with a short TTL turns 150 ms into about 1 ms and removes the cross-region dependency from the critical path.',
        ],
        result:
          'The fix was not faster code, it was fewer round trips and shorter distance. Knowing two numbers - 150 ms cross-region, 1 ms local cache - was enough to redesign the feature in a meeting.',
      },
      {
        title: 'Rounding an estimate and checking it against the exact one',
        setup:
          'A new app expects 12 million daily active users making 8 requests each, with a 5x peak factor. One app server handles about 1,000 requests per second doing real work. This is the setup the Size view of the Lab opens on for this Concept.',
        walkthrough: [
          'Round the big numbers to powers of ten: 12M becomes 10^7 and 8 becomes 10. One went down, one went up.',
          'Requests per day: 10^7 x 10 = 10^8. Exact: 12M x 8 = 96M.',
          'Per second: 10^8 / 10^5 = 10^3. Exact: 96M / 86,400 = 1,111.',
          'Peak: 10^3 x 5 = 5,000 req/sec. Exact: 1,111 x 5 = 5,556 req/sec - the rough answer is 1.1x off.',
          'Servers: 5 at peak, 8 with 50% headroom; exact gives 6 and 9. Both answers say the same thing: a small fleet behind a load balancer.',
        ],
        result:
          'Ten seconds of power-of-ten arithmetic landed within about 10% of the exact answer and picked the same design. The errors cancelled because 12M rounded down while 8 rounded up.',
      },
    ],
    jargon: [
      { term: 'Round trip (RTT)', plain: 'The time for a request to reach a machine and the answer to come back. Distance sets the floor.' },
      { term: 'Order of magnitude', plain: 'A factor of ten. Estimating "to within an order of magnitude" is usually all you need.' },
      { term: 'N+1 query', plain: 'One query to get a list, then one more per item. The classic way to turn one round trip into hundreds.' },
      { term: 'Napkin math', plain: 'Deliberately rough arithmetic used to accept or reject a design before building it.' },
      { term: 'Throughput vs latency', plain: 'How much per second versus how long one item takes. Batching improves the first and can worsen the second.' },
    ],
    remember: [
      'Memory ~100 ns, SSD ~100 us, datacenter hop ~0.5 ms, cross-continent ~150 ms.',
      'Distance is physics: you cannot optimise away a cross-region round trip, only avoid it.',
      'Most big wins come from removing round trips, not from faster code.',
      'Always normalise to per-second and compare against what one machine can do.',
      'A day is 10^5 seconds: round to powers of ten, add exponents, and redo it exactly only near a boundary.',
    ],
  },

  'what-happens-when-you-type-a-url': {
    analogy: {
      title: 'Posting a letter to a company',
      body:
        'You know the company name but not the address, so you look it up in a directory (DNS). You seal the envelope so only they can read it (TLS). The letter reaches a reception desk that may answer common questions itself (the CDN), otherwise it goes to a dispatcher who picks a free clerk (the load balancer), who checks the filing cabinet nearby (the cache) before walking to the archive (the database). The reply comes back the same way, and only then do you read it (rendering).',
    },
    deepDive: [
      {
        heading: 'Stage 1: finding the address, and the five caches on the way',
        paragraphs: [
          'Before any network traffic happens, the browser checks four caches on the machine, in this order. A service worker, if the site registered one, sees the request first and may answer it from its own storage. Next comes the HTTP cache: a fresh stored copy of the page ends the journey right there. Only then does the browser need an address, so it checks the browser DNS cache, then the operating system DNS cache (and the hosts file). A surprising number of "requests" never leave the machine at all, which is why cache headers are among the highest-leverage settings you control.',
          'If the name is still unresolved, a DNS query goes to a resolver, usually run by your ISP or a public provider. The resolver cache is the fifth cache: if someone asked for this name within its TTL, the answer comes straight back. Otherwise the resolver walks the hierarchy - root servers, then the .com nameservers, then the nameservers for the domain - and caches every answer for as long as its TTL says (the list of .com servers for two days, so a busy resolver almost never needs a root server). A cold lookup can take 20-120 ms; a warm one is free.',
          'This is why DNS TTL is an operational decision, not a detail. A 24-hour TTL makes lookups cheap but means a failover takes a day to be noticed by some clients. A 60-second TTL makes failover fast and multiplies DNS traffic. Teams usually lower the TTL days before a planned migration.',
        ],
      },
      {
        heading: 'Stage 2: opening the pipe, and why the first request is expensive',
        paragraphs: [
          'With an IP address the browser opens a TCP connection: SYN, SYN-ACK, ACK - one full round trip before a single byte of your data moves. Then TLS negotiates keys, which is one more round trip with TLS 1.3 (two with 1.2). On a 50 ms link, that is 100-150 ms spent before the HTTP request is even sent. HTTP/3 runs over QUIC, which merges the transport and TLS handshakes into one round trip.',
          'That fixed cost is why connection reuse matters so much. HTTP keep-alive, HTTP/2 multiplexing and connection pools all exist to avoid paying setup again. It is also why a page that pulls resources from eight different domains is slow in a way no backend optimisation can fix - each new origin means a fresh DNS lookup, TCP handshake and TLS handshake.',
          'It is also the clearest argument for a CDN. The handshake cost depends on distance, so terminating TLS at an edge node 20 km away instead of an origin 8,000 km away cuts the setup cost by an order of magnitude, even for content the edge has to fetch from the origin anyway.',
        ],
        code: {
          caption: 'Cold request on a 50 ms link, time before your code runs',
          body: `DNS lookup      ~30 ms   (0 if cached)
TCP handshake   ~50 ms   (1 RTT)
TLS 1.3         ~50 ms   (1 RTT)
HTTP request    ~50 ms   (1 RTT to first byte)
                -------
                ~180 ms  before the server has done anything

Warm connection: ~50 ms. Same server, same code.`,
        },
      },
      {
        heading: 'Stage 3: inside your system, and stage 4: the browser',
        paragraphs: [
          'The request usually meets a CDN edge first, because DNS sent it there: the owner points the name at the CDN (a CNAME on a name such as www, an ALIAS on the bare example.com), so the address the browser got back belongs to an edge near the user. Static assets are answered there and your origin never hears about them. A dynamic request passes through to a load balancer, which picks a healthy application server; that server checks a cache, and only on a miss does it query the database. Each of those hops is a place where the request can be answered early - that is the whole design philosophy of the stack.',
          'On the way back, the response carries the headers that control the next request: Cache-Control, ETag, Set-Cookie, compression. Getting those right is what turns the second visit into a 304 Not Modified or a pure cache hit, which is the cheapest request you will ever serve.',
          'Then the browser does its own pipeline: parse HTML, discover sub-resources, build the DOM and CSSOM, run blocking scripts, lay out, paint. This half is invisible in server metrics and frequently dominates what the user actually experiences. A 50 ms API response inside a page that blocks on a 2 MB JavaScript bundle is still a slow page.',
        ],
        bullets: [
          'Every layer on the path exists to answer earlier: browser cache, DNS cache, CDN, app cache, database.',
          'A request that reaches your database is the most expensive kind. Count how many actually need to.',
          'Server time is only one term. DNS, handshakes, transfer and rendering are the others.',
        ],
      },
    ],
    examples: [
      {
        title: 'Where 1.2 seconds actually goes',
        setup:
          'A user in Bucharest loads a page served from a single origin in Virginia, with no CDN, on a cold connection. The backend handler itself takes 40 ms.',
        walkthrough: [
          'DNS lookup, uncached: about 40 ms.',
          'TCP handshake across the Atlantic: about 120 ms (one round trip).',
          'TLS 1.3 handshake: another 120 ms.',
          'HTTP request to first byte: 120 ms of travel plus 40 ms of actual server work = 160 ms.',
          'Downloading 500 KB of HTML, CSS and JS over the same link with TCP slow start: roughly 400 ms.',
          'Parsing, executing the JavaScript bundle, laying out and painting: about 350 ms.',
        ],
        result:
          'Total about 1.19 seconds, of which your server code accounted for 40 ms - a little over 3 percent. Optimising the handler to 20 ms saves 2 percent; putting a CDN in front and shrinking the bundle saves more than half. Knowing the shape of the journey is how you pick the right fix.',
      },
    ],
    jargon: [
      { term: 'Resolver', plain: 'The DNS server that does the lookup work on your behalf and caches the answer.' },
      { term: 'TTL', plain: 'Time to live: how long a cached DNS answer may be reused before asking again.' },
      { term: 'Handshake', plain: 'The round trips needed to open a connection (TCP) and agree on encryption (TLS), before any data flows.' },
      { term: 'TTFB', plain: 'Time to first byte: how long until the first byte of the response arrives. Includes travel time, not just server time.' },
      { term: 'Edge', plain: 'A CDN server physically near the user that can answer without contacting your origin.' },
      { term: 'Origin', plain: 'Your actual servers - the source of truth the CDN falls back to.' },
    ],
    remember: [
      'The first request pays DNS + TCP + TLS before your code runs at all - often 150 ms or more.',
      'Every layer on the path is a chance to answer earlier; the database is the last resort.',
      'Server time is usually a small slice of what the user experiences.',
      'Reusing a connection is the cheapest performance win available.',
      'This one journey touches DNS, TCP, TLS, CDN, load balancing, caching and databases - it is the map of everything else.',
    ],
  },
};
