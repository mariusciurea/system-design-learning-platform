import type { Concept } from '@/types';

export const gettingStartedConcepts: Concept[] = [
  {
    slug: 'what-is-system-design',
    title: 'What is System Design?',
    tagline: 'Choosing a structure that satisfies requirements you can actually name.',
    category: 'getting-started',
    difficulty: 'Beginner',
    lab: 'requirements',
    labFocus: 'what-is-system-design',
    keywords: ['introduction', 'architecture', 'trade-offs'],
    what: 'System design is the activity of deciding which components a system is made of, how they communicate, and where state lives - so that the result meets its functional and non-functional requirements at an acceptable cost.',
    why: 'Code tells you what a single process does. Design tells you what happens when a million users arrive at once, when a disk fails, or when two services disagree about the truth. Those questions cannot be answered by reading a function body.',
    how: [
      'Clarify the requirements: what the system must do, and how well it must do it.',
      'Estimate scale: users, requests per second, data volume, read/write ratio.',
      'Sketch the smallest architecture that could work.',
      'Find the bottleneck - there is always exactly one that matters first.',
      'Introduce a component that removes it, and name the new problem it creates.',
      'Repeat until the remaining problems are acceptable.',
    ],
    when: [
      'Before building anything whose failure would be expensive.',
      'When an existing system stops meeting its latency or availability targets.',
      'In interviews, where the process matters more than the final diagram.',
    ],
    diagram: `Requirements  ->  Estimate  ->  Simple design
                                  |
                            find bottleneck
                                  |
                           add one component
                                  |
                            name the new cost
                                  |
                               repeat`,
    mistakes: [
      'Starting from a list of technologies instead of a list of requirements.',
      'Drawing the final Netflix-scale architecture for a product with 200 users.',
      'Treating a diagram as finished before anyone has asked "what happens when this box dies?".',
    ],
    tradeoffs: [
      {
        approach: 'Design up front',
        gains: ['Fewer expensive rewrites', 'Shared mental model across the team'],
        costs: ['Slower start', 'Decisions made with the least information you will ever have'],
      },
      {
        approach: 'Evolve the design',
        gains: ['Decisions made when you know more', 'Ships sooner'],
        costs: ['Migrations under load are painful', 'Some choices are hard to reverse (data model, partitioning)'],
      },
    ],
    related: ['functional-requirements', 'non-functional-requirements', 'capacity-estimation'],
    quiz: [
      {
        id: 'wsd-1',
        prompt: 'A team proposes microservices, Kafka and a global multi-region database for an internal tool with 300 daily users. What is the most useful first question?',
        options: [
          'Which cloud provider offers the cheapest managed Kafka and database?',
          'Which requirement makes any of this complexity necessary?',
          'How many Kafka partitions do we need so consumers never fall behind?',
          'Should the services talk over gRPC or REST, given the latency budget?',
        ],
        answer: 1,
        explanation:
          'Architecture is justified by requirements. With 300 users, none of that machinery is paid for by a real constraint, and every piece of it adds operational cost. Picking a cloud or a partition count first skips the question of whether the parts are needed at all.',
      },
      {
        id: 'wsd-2',
        prompt: 'In the Requirements Lab, Instagram at 100k daily users runs on one App server and one Database, and nothing is over its limit: about 174 requests/s at peak against the 1,000 one server handles. A teammate says the design is too simple to be real. What is the right response?',
        options: [
          'Add a cache and read replicas now, so later growth does not force a rewrite of the design',
          'Add a second region now, because moving to multi-region later means a painful migration',
          'It meets these requirements; add a part only when a requirement or a bottleneck forces it',
          'Replace the database with a NoSQL store, because social apps at scale all use NoSQL',
        ],
        answer: 2,
        explanation:
          'A design is right relative to its requirements. At 100k daily users the peak is about 174 requests/s, far below what one App server handles, so every stated number is met. A cache, replicas or a second region would be parts no requirement pays for - they cost money and operations every day. The Lab shows the same thing: nothing turns red until you raise the users, and only then is one component added.',
      },
      {
        id: 'wsd-3',
        prompt: 'A URL shortener is estimated at about 1,160 redirects per second and 12 new links per second, running on one Postgres instance. Which single component is the most useful to add first?',
        options: [
          'A cache in front of the database, keyed by short code',
          'Sharding the database across four machines to spread the load',
          'A message queue in front of the writes to absorb the spikes',
          'Splitting redirect and create into two microservices',
        ],
        answer: 0,
        explanation:
          'Reads outnumber writes about 100 to 1, so the first thing to saturate is the read path, and a cache relieves exactly that. Sharding solves a storage or write problem the estimate does not show (about 0.5 GB a day fits one machine for years), and a queue in front of 12 writes per second fixes nothing.',
      },
      {
        id: 'wsd-4',
        prompt: 'You just added a cache in front of the database and the read latency dropped. According to the design loop, what is the step people most often skip?',
        options: [
          'Adding a second cache node so the cache is not a new single point of failure',
          'Naming the new problem it creates, such as a deleted link that still resolves',
          'Sharding the database now, while the team is already changing the data path',
          'Nothing - the measured bottleneck is fixed, so this part of the design is done',
        ],
        answer: 1,
        explanation:
          'Every component solves one problem and brings a new one. A cache brings stale data; saying so out loud is what lets you decide whether an expiry time or an invalidation is needed. Declaring the design finished hides that cost, and adding more parts before naming it repeats the mistake.',
      },
      {
        id: 'wsd-5',
        prompt: 'Two teams build products with the same feature list. One must reach 99.9% availability, the other 99.999%. What should you expect of their architectures?',
        options: [
          'They will be the same, because the architecture follows the feature list',
          'The 99.999% team only needs faster, more expensive servers with better hardware',
          'They will differ only in monitoring, so the stricter team gets paged sooner',
          'They will differ: 99.999% forces extra copies, automated failover and several regions',
        ],
        answer: 3,
        explanation:
          'Features decide what the system does; the quality targets decide how it must be built. 99.999% allows about 5 minutes of downtime a year - no human can react in time - so it forces redundancy everywhere and automated failover across regions. Faster servers do not survive a machine or a region failing.',
      },
      {
        id: 'wsd-6',
        prompt: 'In an interview you are asked "SQL or NoSQL for this service?" and you do not know the access pattern yet. What is the most useful answer?',
        options: [
          'Name what it depends on - access pattern, write rate, joins - and choose once known',
          'NoSQL, because it scales horizontally and SQL databases hit a ceiling at scale',
          'SQL, because it is always the safe default and can be migrated away from later',
          'Both - SQL for the joins and NoSQL for the writes, so either kind of query is covered',
        ],
        answer: 0,
        explanation:
          '"It depends" is only useful when you say what it depends on. One known key at 50k writes per second points to a key-value store; ad-hoc joins across five entities point to a relational database. A blanket answer ignores the inputs, and "both" doubles the parts to operate without a requirement asking for it.',
      },
      {
        id: 'wsd-7',
        prompt: 'In the Requirements Lab, Instagram at 1M daily users sends 1,736 requests/s and the App server turns red. You pick one 8x machine and it turns green. At 10M daily users (17,361 requests/s) it is red again. What does that show?',
        options: [
          'The 8x machine was sized wrong: a bigger machine should always last until the target',
          'A bigger machine multiplies capacity once, while a pool of servers grows with the load',
          'The Database is the real bottleneck, and the App server only looks overloaded to us',
          'The fix should have been a cache, because a cache takes load off the App server too',
        ],
        answer: 1,
        explanation:
          'An 8x machine handles 8,000 requests/s: enough for 1M daily users, not for 10M. A fix that multiplies capacity by a fixed factor buys one round; more app servers behind a load balancer grow with the load, at the price of stateless servers. A cache sits in front of the Database, so it takes reads off the Database, not requests off the App server.',
      },
      {
        id: 'wsd-8',
        prompt: 'Your team decides to evolve the design as usage grows instead of designing everything up front. Which decision still deserves careful thought now?',
        options: [
          'The number of app servers, since each one adds cost every month',
          'The cache expiry time, because a wrong value serves stale data',
          'The log format, because every dashboard is built on it',
          'The data model and the partitioning key',
        ],
        answer: 3,
        explanation:
          'Evolving the design ships sooner, but some choices are expensive to reverse: changing the data model or the partitioning key means migrating data under load. Server counts, cache expiry times and log formats can change any day with little risk.',
      },
      {
        id: 'wsd-9',
        prompt: 'An engineer adds Kafka to a design "in case we need it later". No requirement or estimate mentions streaming or high write rates. What is the real cost?',
        options: [
          'None - an unused component sits idle, so it costs nothing until traffic arrives',
          'A part to deploy, monitor, upgrade and be paged for, that no requirement pays for',
          'Only the licence fee for the Kafka cluster, which grows with each broker',
          'No net cost - an extra buffer makes the design more reliable, which pays for it',
        ],
        answer: 1,
        explanation:
          'Over-engineering is complexity no requirement pays for. Every component can fail, needs on-call knowledge and adds a hop, so it lowers reliability rather than raising it. Kafka is open source, so the cost is not a licence - it is the operations.',
      },
      {
        id: 'wsd-10',
        prompt: 'A design review shows one database box that everything depends on. The target is 99.99% availability, and nobody has asked what happens when that box dies. What should you do next?',
        options: [
          'Ask what happens when it dies: 99.99% needs a standby with automated failover',
          'Approve it - managed databases rarely fail, and the nightly backups cover the rare case',
          'Add more CPU and memory to the database so it is less likely to fall over',
          'Add a cache so the database is used less and matters less when it is down',
        ],
        answer: 0,
        explanation:
          'A diagram is not finished until every box has been asked "what if this dies?". A recovery done by hand takes a large part of the 52-minute yearly budget, so 99.99% forces a standby with automatic promotion. More CPU or a cache do nothing when the machine is gone.',
      },
      {
        id: 'wsd-11',
        prompt: 'A service passes every unit test, yet the product goes down for 20 minutes whenever its only machine reboots for a kernel update. What does this show?',
        options: [
          'The unit tests were wrong, because they never covered the reboot path',
          'The code needs better error handling so it survives a sudden restart',
          'Correct code is not enough: the design decides what a reboot does',
          'Kernel updates should be skipped on the machine that runs production',
        ],
        answer: 2,
        explanation:
          'Code answers "is the output correct for this input?". Design answers "does it keep working at scale, with a dead node, during a partition?". The tests can be perfect and the function correct; with one machine, its reboot is an outage. Skipping security updates just trades this outage for a worse one.',
      },
      {
        id: 'wsd-12',
        prompt: 'A photo app at 10M daily users runs on one app server (1,000 requests/s) and one database copy (10,000 reads/s). At peak the users send 17,361 requests/s, 16,493 of them reads. Which part is the bottleneck to fix first?',
        options: [
          'The app server: it passes on at most 1,000 requests/s, so the database never sees more',
          'The database: 16,493 reads/s is the bigger overload, so it saturates before anything else',
          'Both at once: fix them in one change, or the one left alone caps the fix of the other',
          'Neither: at peak both queue the extra work and then catch up during the quiet hours',
        ],
        answer: 0,
        explanation:
          'Requests meet the app server first, and it turns away everything past its 1,000 requests/s - so the database behind it sees fewer than 1,000, well under its limit. Fix the app server and the full 16,493 reads/s reach the database, which becomes the next bottleneck: that is the order the Lab shows at 1M and then 10M daily users. A peak that lasts an hour does not wait for the quiet hours.',
      },
    ],
  },
  {
    slug: 'functional-requirements',
    title: 'Functional Requirements',
    tagline: 'What the system must do, stated as behaviour a user can observe.',
    category: 'getting-started',
    difficulty: 'Beginner',
    lab: 'requirements',
    labFocus: 'functional-requirements',
    keywords: ['requirements', 'scope', 'features'],
    what: 'Functional requirements describe the features and behaviours of a system: what a user can do, and what the system produces in response.',
    why: 'They define scope. Without an explicit list, every design discussion silently assumes a different product, and the architecture ends up sized for features nobody agreed to build.',
    how: [
      'Write each requirement as an action: "a user can send a message to a group".',
      'Separate the core flows from the nice-to-haves - the core flows drive the architecture.',
      'For each requirement, ask which data it reads and which data it writes.',
      'Only then decide which components you need.',
    ],
    when: [
      'At the start of every design, including interviews - always scope before designing.',
      'When a feature request arrives, to check whether the current architecture supports it.',
    ],
    diagram: `Design WhatsApp

  [x] Send messages              -> App server + Database
  [x] Receive messages live      -> WebSocket server
  [x] Group conversations        -> Queue + workers
  [x] Delivery and read receipts -> 3 pushes per message
  [ ] Voice and video calls      -> Media servers: not built
  [ ] Send images, Stories       -> Object storage + CDN: not built`,
    tradeoffs: [
      {
        approach: 'Pin down a short feature list before designing',
        gains: ['The design is sized for features that exist, not imagined ones', 'Scope creep is visible because every addition is a written change'],
        costs: ['Some real needs surface late and force rework', 'Time spent in the interview or planning before any architecture appears'],
      },
      {
        approach: 'Design for a broad feature set up front',
        gains: ['Fewer surprises when later features arrive', 'Data model can anticipate future queries'],
        costs: ['More components to build, run and explain', 'Complexity is paid for features that may never ship'],
      },
    ],
    mistakes: [
      'Mixing in quality attributes: "must be fast" is non-functional, not functional.',
      'Accepting an unbounded feature list and then designing for all of it at once.',
      'Forgetting the unglamorous flows (search, delete, export) that shape the data model.',
    ],
    related: ['non-functional-requirements', 'capacity-estimation', 'what-is-system-design'],
    quiz: [
      {
        id: 'fr-1',
        prompt: 'You are sorting a product brief for a social app into two lists before designing. Which line belongs on the functional requirements list?',
        options: [
          'The feed p95 is under 200 ms',
          'A user can follow another user',
          'The service is available 99.99% of the time',
          'Data is replicated to three availability zones',
        ],
        answer: 1,
        explanation:
          'Following a user is behaviour a user can observe. Latency and availability describe how well the system behaves - they go on the non-functional list - and replication across zones is not a requirement at all but a design decision made to meet one.',
      },
      {
        id: 'fr-2',
        prompt: 'An interviewer opens with "Design Twitter" and waits. What is the best first move?',
        options: [
          'Draw the load balancer, app servers and database straight away',
          'Ask which database Twitter uses in production, so the design matches reality',
          'Estimate the storage for ten years of tweets, since that sizes everything else',
          'Propose a scope - post, follow, home timeline - and say what is out, such as DMs',
        ],
        answer: 3,
        explanation:
          '"Design Twitter" is a brand name, not a set of requirements. Thirty seconds of agreed scope decides what every later box is for. Drawing or estimating first sizes the design for a product nobody agreed on, and the real Twitter database says nothing about your requirements.',
      },
      {
        id: 'fr-3',
        prompt: 'A requirements list for a photo app contains the line "Photos are stored in S3". What is wrong with it?',
        options: [
          'Nothing - S3 is durable and cheap, so naming it early saves a debate later',
          'It is a solution written as a requirement; state the user behaviour instead',
          'It should say "Photos are served from a CDN", since users read far more than they write',
          'It is a non-functional requirement about storage and belongs in the other list',
        ],
        answer: 1,
        explanation:
          'A technology name in the requirements smuggles a decision in without debate. Stated as user behaviour, the requirement leaves the storage choice open until the design, where it can be argued. It is not non-functional either - it names no quality target, only an implementation.',
      },
      {
        id: 'fr-4',
        prompt: 'A stakeholder adds "The app must be fast" to the functional requirements. What should you do with it?',
        options: [
          'Move it to the non-functional list with a number, such as feed p95 under 200 ms',
          'Keep it on the functional list - speed is a feature users notice and ask for by name',
          'Delete it - "fast" is too vague to design for, so it only adds noise',
          'Replace it with "use a cache", since caching is what makes an app fast',
        ],
        answer: 0,
        explanation:
          'It describes how well, not what, so it is non-functional - and without a number nobody can tell when it is met. Deleting it loses a real expectation, and "use a cache" is a solution that may or may not be what meets the number.',
      },
      {
        id: 'fr-5',
        prompt: 'In the Requirements Lab (Design Instagram) you tick "Search users and tags". A Search index appears, fed by the Queue + workers box. Why does one checkbox add these parts?',
        options: [
          'Search is a quality target, like latency, so ticking it adds infrastructure',
          'The main database cannot store user names or tags, so they are moved to a separate store',
          'Search needs its own index, kept in step with the database by background workers',
          'Every Instagram-style design must have a search index from the start',
        ],
        answer: 2,
        explanation:
          'Full-text and prefix search over names and tags is served by a separate index, and something must copy every change into it - here, workers reading events from a queue. Search is a feature, not a quality target, and the diagram only has an index while that feature is ticked.',
      },
      {
        id: 'fr-6',
        prompt: 'You have the requirement "A user can see a feed of posts from people they follow". Which question about it shapes the architecture most?',
        options: [
          'Which frontend framework will render the feed, since it sets the page load time',
          'What colour and size the feed cards are, since that drives engagement',
          'Whether posts need an edit history, since that changes the data model',
          'What it reads and writes, and how often - feeds are read far more than written',
        ],
        answer: 3,
        explanation:
          'Reads, writes and their rate are what components are built to serve. A read-heavy feed points to caching and precomputed timelines. The framework and the card colour do not change a single box, and edit history is a separate requirement.',
      },
      {
        id: 'fr-7',
        prompt: 'A team listed only post, follow and view feed. A year later a legal request arrives: "a user can delete their account and all their data". Why is this now painful?',
        options: [
          'Copies sit in tables, caches, the CDN and object storage, and the model never planned for it',
          'Deletes are slower than inserts in every database, so removing years of data takes weeks',
          'Legal requests always need a separate, audited database, and the team does not have one yet',
          'It is not painful - one DELETE statement with a WHERE on user id handles it everywhere',
        ],
        answer: 0,
        explanation:
          'The unglamorous requirements - delete, export, search, edit - shape the data model. Missing one at the start means reworking storage later. One DELETE on one table leaves copies in caches, feeds, the CDN and object storage.',
      },
      {
        id: 'fr-8',
        prompt: 'In the Requirements Lab (Design WhatsApp) you tick "Voice and video calls". The grey Media servers box turns into a built part and "Beyond core" goes up. The product manager says it is just one more checkbox. What is the honest answer?',
        options: [
          'Agree - the app servers already hold a WebSocket to each phone and can relay audio',
          'Calls are a separate system (media relays, signalling): scope them out or plan a subsystem',
          'Add it, because the diagram barely changes and the media servers are only one extra box',
          'Replace WebSockets with calls, since a call connection can carry chat messages as well',
        ],
        answer: 1,
        explanation:
          'Real-time audio and video need media relays built for it, with their own scaling and bandwidth costs - the Lab marks the feature as extra for that reason. App servers built for small messages are the wrong place to relay media, and the WebSocket server is still needed to ring the other phone.',
      },
      {
        id: 'fr-9',
        prompt: 'You design posting, following and the feed without mentioning direct messages. Near the end the interviewer asks "and where do DMs fit?". What would have prevented this?',
        options: [
          'Designing for every feature Twitter has from the start, so nothing can surprise you',
          'Adding a message queue in advance, since DMs are just messages on a queue anyway',
          'Saying at the start that DMs are out of scope, so the exclusion was agreed',
          'Nothing - interviewers always add a feature at the end to test adaptability',
        ],
        answer: 2,
        explanation:
          'An unlisted feature is an assumed feature: the other person was holding it in their head. Naming exclusions makes them negotiable at the start instead of a surprise at the end. Designing for everything, or adding parts in advance, pays for features that may never be asked for.',
      },
      {
        id: 'fr-10',
        prompt: 'You have nine candidate features for a photo app. Which ones should drive the architecture?',
        options: [
          'All nine, weighted equally, so nothing is missed and no feature forces a redesign',
          'The ones that are hardest to build, since they carry the most technical risk',
          'The ones the team has built before, so the estimates are reliable',
          'The two or three core flows that carry most traffic, like the home feed',
        ],
        answer: 3,
        explanation:
          'A few core flows create nearly all the load and so all the architectural pressure; everything else rides on the same infrastructure. Weighting all nine equally sizes the system for rare features, and difficulty or familiarity say nothing about load.',
      },
      {
        id: 'fr-11',
        prompt: 'A team designs for fifteen features although only three are planned this year, "so we will not have to redesign later". What do they pay for it?',
        options: [
          'Nothing - a broad design is always cheaper than redesigning under load later',
          'More components to build, run and explain now, paid for features that may never ship',
          'Only a slightly longer design document, since nothing extra is built yet',
          'Lower availability, because fifteen features cannot fit on one server and must be split',
        ],
        answer: 1,
        explanation:
          'Designing broad up front gains fewer surprises later but costs complexity today, much of it for features that may be cut. Pinning a short list costs some rework when a real need appears late. Neither is free - that is the trade-off.',
      },
    ],
  },
  {
    slug: 'non-functional-requirements',
    title: 'Non-Functional Requirements',
    tagline: 'How well the system must behave - and what that costs you.',
    category: 'getting-started',
    difficulty: 'Beginner',
    lab: 'requirements',
    labFocus: 'non-functional-requirements',
    keywords: ['availability', 'latency', 'consistency', 'durability', 'slo'],
    what: 'Non-functional requirements (NFRs) are the quality attributes of a system: availability, latency, throughput, consistency, durability, cost, security and operability.',
    why: 'NFRs, not features, are what force architecture. Two products with identical feature lists but different availability targets end up with completely different infrastructure.',
    how: [
      'Put a number on every attribute: "99.9%", "p95 < 200 ms", "no data loss on a single node failure".',
      'Translate each number into structure: 99.99% means redundancy plus automated failover.',
      'Check which attributes conflict - strong consistency and low latency across regions pull in opposite directions.',
      'Decide explicitly which one loses when they conflict.',
    ],
    when: [
      'Before choosing a database, a replication mode or a deployment topology.',
      'When defining SLOs with the people who will be paged.',
    ],
    diagram: `Availability target    Downtime per year
99%                    ~3.65 days
99.9%                  ~8.8 hours
99.99%                 ~52 minutes
99.999%                ~5.3 minutes`,
    advantages: [
      'Makes implicit expectations arguable instead of assumed.',
      'Gives you a stopping rule: you are done when the numbers are met.',
    ],
    tradeoffs: [
      {
        approach: 'Very high availability (99.99%+)',
        gains: ['Survives zone loss', 'Failover without human involvement'],
        costs: ['Copies in 2-3 zones cost roughly 2-3x', 'More moving parts to operate', 'Going multi-region usually forces weaker consistency'],
      },
      {
        approach: 'Strong consistency everywhere',
        gains: ['Simple mental model', 'No stale reads to explain to users'],
        costs: ['Cross-region writes pay a round trip', 'Reduced availability during partitions (see CAP)'],
      },
    ],
    mistakes: [
      'Asking for "five nines" without pricing it.',
      'Averaging latency instead of looking at p95/p99, where real users live.',
      'Specifying consistency as a slogan rather than per operation - a "like" and a payment need different guarantees.',
    ],
    related: ['functional-requirements', 'cap-theorem', 'high-availability', 'slo'],
    quiz: [
      {
        id: 'nfr-1',
        prompt: 'A product owner asks for 99.999% availability on a service that runs as a single instance with a single database. What is the honest response?',
        options: [
          'Add more CPU and memory to the instance so it never becomes the bottleneck',
          'It forces redundancy, automated failover and several zones - a new design and budget',
          'Set a monitoring alert that pages on-call within a minute of a failure',
          'Enable database backups every 15 minutes, so a failure loses almost nothing',
        ],
        answer: 1,
        explanation:
          '99.999% allows about 5 minutes of downtime per year - less than it takes to page a human, let them log in and restart anything. The number is an architecture decision, not a configuration flag. More CPU, an alert or backups all leave the single instance as the thing that takes everything down.',
      },
      {
        id: 'nfr-2',
        prompt: 'The dashboard shows an average latency of 99 ms, yet users complain the app is slow. Out of 100 requests, 99 take 50 ms and one takes 5 seconds. How should the latency target be stated?',
        options: [
          'As the average - 99 ms is well under any sensible limit, so the complaints are noise',
          'As the median, because it ignores the rare outliers that distort the numbers',
          'As a percentile such as p99, which shows the slow tail the average hides',
          'As the fastest request, to show the latency the system reaches on a good path',
        ],
        answer: 2,
        explanation:
          'The average mixes one 5-second wait into 99 fast requests and looks fine. p99 reports what the slowest 1 in 100 requests experience - exactly the users complaining. The median ignores them by design, which is the opposite of what you need here.',
      },
      {
        id: 'nfr-3',
        prompt: 'A page makes 20 backend calls. Each call has a p99 latency of 1 second. Roughly what share of page loads waits for at least one 1-second call?',
        options: [
          'About 1%',
          'About 18%',
          'About 50%',
          'About 99%',
        ],
        answer: 1,
        explanation:
          'The chance that all 20 calls are fast is 0.99^20, about 0.82, so about 18% of page loads hit at least one slow call. 1% would be true for a single call; the tail grows with every call a page makes, which is why tail latency matters more at scale.',
      },
      {
        id: 'nfr-4',
        prompt: 'In the Requirements Lab you move Availability from 99.9% to 99.99%. What changes on the diagram, and why?',
        options: [
          'Nothing - availability is a monitoring setting, so only the alert thresholds change',
          'A second region appears, because four nines always needs two regions that can each serve everything',
          'Only the load balancer gets bigger, since it absorbs the failures for the servers',
          'Three zones and an auto-promoted database standby: 52 minutes a year allows no manual fix',
        ],
        answer: 3,
        explanation:
          'At 99.99% a manual database recovery or one lost zone would use up the yearly budget, so the database gets a standby that is promoted automatically and every other tier - app servers, cache, queue, index - keeps a copy in each of 3 zones. A second region is what the Lab adds at 99.999%, where even a region outage must be survived.',
      },
      {
        id: 'nfr-5',
        prompt: 'A social app has like counters and in-app payments. How should its consistency requirement be written?',
        options: [
          'Per operation: a like count may be a few seconds stale, a payment balance must never be',
          'Strong consistency everywhere, to be safe, since a stale like and a stale balance are both bugs',
          'Eventual consistency everywhere, for speed, with payments reconciled nightly',
          'Consistency does not need to be specified; the database default handles it',
        ],
        answer: 0,
        explanation:
          'Almost every real product has both kinds of data. Strong everywhere makes likes pay for guarantees nobody needs; eventual everywhere lets a balance be wrong. Leaving it unspecified means each engineer picks a different answer.',
      },
      {
        id: 'nfr-6',
        prompt: 'A global app asks for strong consistency on every write across two regions, and a p95 write latency of 20 ms. What happens?',
        options: [
          'Both targets can be met with faster databases on NVMe disks in each region',
          'Both targets can be met with a write-through cache in front of the databases',
          'They conflict: a strong write waits on the other region, often 50-100 ms away',
          'Strong consistency makes writes faster by skipping conflict resolution, so 20 ms is easy',
        ],
        answer: 2,
        explanation:
          'Strong consistency across regions means a write is not confirmed until the other region has it, so every write pays a cross-region round trip - a limit set by distance, not by hardware. One target has to give way. A cache does not help writes that must be confirmed in two places.',
      },
      {
        id: 'nfr-7',
        prompt: 'A service targets 99.99%. Each deploy restarts it for about 45 seconds, and the team deploys 12 times a month. What does that mean?',
        options: [
          'Nothing - planned downtime announced in advance does not count',
          'Deploys alone use about 108 minutes a year, twice the budget: they must be zero-downtime',
          'The team should deploy less often, say monthly, and keep the single instance',
          'The budget is fine - 45 seconds is short, and users just retry during a restart',
        ],
        answer: 1,
        explanation:
          '12 deploys x 12 months x 45 seconds is 108 minutes, and 99.99% allows about 52 minutes a year for everything. Users do not care whether downtime was planned. Deploying less often still leaves every restart as an outage and slows the team down. Zero-downtime deploys need at least two instances behind a load balancer.',
      },
      {
        id: 'nfr-8',
        prompt: 'A product owner writes "The system must be reliable" in the requirements. What is the most useful thing to do with it?',
        options: [
          'Accept it as written, since the whole team already agrees on what reliable means',
          'Replace it with "use Kubernetes", since Kubernetes restarts failed containers automatically',
          'Delete it, because reliability cannot be measured until the system is in production',
          'Turn it into numbers, such as 99.9% monthly availability and no lost acknowledged write',
        ],
        answer: 3,
        explanation:
          'A requirement without a number has no stopping rule: nobody can tell when it is met or what it costs. With numbers it can be priced and designed for. Naming a tool is a solution, not a target, and reliability is measured all the time.',
      },
      {
        id: 'nfr-9',
        prompt: 'Uber must lose no acknowledged payment if the machine holding its database dies. Which design meets that target?',
        options: [
          'A synchronous standby in a second zone, so a payment is confirmed only once both copies hold it',
          'An asynchronous replica in another zone, promoted to primary when the machine holding the data dies',
          'Nightly backups copied to object storage in another region, restored when the machine dies',
          'A bigger RAID disk array on the one machine, so that no single disk failure can lose a payment',
        ],
        answer: 0,
        explanation:
          'With asynchronous replication the primary confirms before the copy arrives, so the last moments of writes can vanish with the machine. Nightly backups lose up to a day, and a bigger disk dies with its machine. Only a copy confirmed before the acknowledgement meets "no acknowledged write lost". In the Lab that is Critical durability: the Database becomes Database x2, a synchronous standby in a second zone, its stat turns to Peak sync writes because each write waits for the standby, and the monthly cost goes from x1 to x1.5.',
      },
      {
        id: 'nfr-10',
        prompt: 'A team copies Netflix multi-region architecture for an internal HR tool used by 200 people in one office. What is the problem?',
        options: [
          'Netflix uses in-house technologies that are not available to other companies',
          'Nothing - copying a proven architecture removes risk, since Netflix debugged it',
          'It answers the Netflix numbers; 200 users pay for redundancy no requirement asks for',
          'Multi-region is not possible for internal tools that sit behind a corporate VPN',
        ],
        answer: 2,
        explanation:
          'An architecture is the answer to a set of numbers. Netflix built for hundreds of millions of streams and region failures; 200 users in one office need neither. Copying it adds cost and operations with nothing in return - the risk goes up, not down.',
      },
      {
        id: 'nfr-11',
        prompt: 'In the Requirements Lab on Uber you keep the core features and move Daily active users from 100k to 10M. Which change do you see, and why?',
        options: [
          'App servers go from 6 to 479 and a Cache appears; one database primary still takes the trip writes',
          'Only the app servers grow, from 6 to 60, since each app server serves a fixed share of the riders',
          'The database is split into partitions, since 10M riders send more trip writes than one primary can take',
          'A second region appears, since 10M daily users are too many to serve from one region of 3 zones',
        ],
        answer: 0,
        explanation:
          'Every online driver sends a location every 4 seconds - 540 writes a day for each daily user on average, against 10 rider requests - so the peak is about 318,000 requests a second, and at 1,000 each plus 50% headroom that is 479 app servers (6 at 100k). Those location writes land in the in-memory Geo index (about 312,500 a second), not the database: trips add only about 1,160 writes a second at peak, far under the 10,000 one primary absorbs, so the database is not split. A Cache appears for the hot reads, and the Queue + workers already drawn for payments also take anything slow. A second region only appears at 100M users or 99.999%.',
      },
    ],
  },
  {
    slug: 'capacity-estimation',
    title: 'Capacity Estimation',
    tagline: 'Turning user counts into requests per second, gigabytes and bandwidth.',
    category: 'getting-started',
    difficulty: 'Beginner',
    lab: 'capacity',
    labFocus: 'capacity-estimation',
    keywords: ['estimation', 'qps', 'storage', 'bandwidth', 'back of the envelope'],
    what: 'Capacity estimation converts product numbers (users, actions per user) into infrastructure numbers (requests per second, servers, storage per year, bandwidth).',
    why: 'It tells you whether you are designing for 50 requests per second or 50,000 - and those are different systems. It also catches impossible requirements early.',
    how: [
      'Start from daily active users and actions per user per day.',
      'Divide by 86,400 to get the average rate per second.',
      'Multiply by a peak factor (2-10x) - traffic is never flat.',
      'Divide the peak by what one server handles (about 1,000 req/sec when each request does real work) and add headroom.',
      'Multiply writes per day by object size for storage per day, then by 365 for storage per year (one copy).',
      'Multiply storage per year by the retention in years for what you keep, then by the replication factor for what you store.',
      'Compute bandwidth as request rate times payload size, and check it against a single machine.',
    ],
    when: ['Early in any design discussion.', 'Before picking a storage engine or a sharding strategy.'],
    diagram: `10,000,000 DAU x 20 requests/day = 200,000,000 requests/day

200,000,000 / 86,400   ~=  2,315 req/sec  (average)
2,315 x 5 peak factor  ~= 11,574 req/sec  (peak)
11,574 / 1,000 per server = 12, x 1.5 headroom = 18 servers

Writes 10% -> ~231 writes/sec average, ~1,157 at peak

20,000,000 writes/day x 2 KB  = 40 GB/day
40 GB/day x 365 days          = 14.6 TB/year   (per year, one copy)
14.6 TB/year x 5 years        = 73 TB kept     (retention)
73 TB x 3 copies              = 219 TB stored  (replication)`,
    tradeoffs: [
      {
        approach: 'Size from explicit estimates (DAU x requests x peak factor)',
        gains: ['Numbers justify choices such as sharding, caching or a single database', 'Order-of-magnitude mistakes are caught before they are built'],
        costs: ['Inputs are guesses, so the output is only as good as its assumptions', 'Needs revisiting as real traffic data arrives'],
      },
      {
        approach: 'Provision generous headroom above the estimate',
        gains: ['Absorbs spikes and estimation error without an outage', 'Buys time before the next scaling step'],
        costs: ['Idle capacity is paid for every month', 'Can hide an inefficient design until the bill arrives'],
      },
    ],
    mistakes: [
      'Designing for the average and being paged during the peak.',
      'Forgetting that reads and writes have wildly different costs.',
      'Forgetting the replication factor and the retention period in the storage estimate.',
      'Precision theatre: 11,574 and "about 10k" lead to the same decisions.',
    ],
    related: ['back-of-the-envelope', 'non-functional-requirements', 'sharding', 'horizontal-scaling'],
    quiz: [
      {
        id: 'cap-est-1',
        prompt: 'A system has 86.4 million requests per day with a 4x peak factor. Roughly what peak QPS should you design for?',
        options: ['1,000', '4,000', '10,000', '40,000'],
        answer: 1,
        explanation:
          '86.4M / 86,400 = 1,000 requests/sec average. With a 4x peak factor you size for about 4,000 requests/sec. 1,000 is the tempting answer, but it is the average second, and the average second never happens.',
      },
      {
        id: 'cap-est-2',
        prompt:
          'A photo app expects 1 million uploads a day at 2 MB each, keeps every photo forever and stores 3 copies. How much new storage does one year need?',
        options: ['About 2.2 PB', 'About 730 TB', 'About 2 TB', 'About 730 GB'],
        answer: 0,
        explanation:
          '1M x 2 MB = 2 TB a day; x 365 = 730 TB a year; x 3 copies = about 2.2 PB. 730 TB is the tempting answer: it is right for one copy, but every replica is billed storage. 2 TB is one day, not a year.',
      },
      {
        id: 'cap-est-3',
        prompt:
          'A team sized its fleet for the average of 2,000 req/sec, with no headroom. Most traffic arrives in the evening and the peak factor is 5x. What happens every evening?',
        options: [
          'Nothing - capacity plans are always based on the average, and servers can burst',
          'Only the database slows down, since app servers are stateless and handle bursts',
          'The fleet sees 10,000 req/sec, five times its capacity, so queues and errors build',
          'Traffic is spread over the day automatically, so the peak never reaches the servers',
        ],
        answer: 2,
        explanation:
          'The peak is average x peak factor: 2,000 x 5 = 10,000 req/sec against capacity for 2,000. Traffic is not spread out for you - users arrive when they want. That is why the Lab sizes the App tier from the peak, not the average.',
      },
      {
        id: 'cap-est-4',
        prompt:
          'In the Lab you double Daily active users from 10M to 20M and change nothing else. What happens to the estimates?',
        options: [
          'Requests, storage growth and bandwidth all double; the read:write ratio stays put',
          'Only requests per second doubles; storage depends on the object size, not on users',
          'Everything quadruples, because users double and each user also sends more requests',
          'Only the App tier grows; the database and object storage are sized separately',
        ],
        answer: 0,
        explanation:
          'Every estimate is DAU multiplied by something, so each one doubles: requests, writes, storage and bandwidth. The read:write ratio depends only on the write share, so it stays put. Storage does depend on users - more users make more writes, and every write adds an object.',
      },
      {
        id: 'cap-est-5',
        prompt:
          'The estimate says 10,417 peak reads/sec and 1,157 peak writes/sec. The database primary is struggling, and a teammate adds three read replicas. What does that change?',
        options: [
          'Writes spread across all four machines, so the primary does a quarter of the work',
          'Reads can move to the replicas; the primary still takes all 1,157 writes/sec',
          'Nothing - replicas exist only for durability, never for load',
          'Both reads and writes roughly halve, since the load now has more machines to use',
        ],
        answer: 1,
        explanation:
          'Replicas copy the data of the primary and can answer reads, which is most of this load (about 9:1). Every write still goes to the one primary, then gets copied to each replica. Replicas relieve reads; only partitioning spreads writes.',
      },
      {
        id: 'cap-est-6',
        prompt:
          'In the Lab you raise the write share from 10% to 90% and the Database card turns to "Partition the writes": peak writes are 10,417/sec against a planning limit of about 10,000 for one primary. What does the estimate tell you to plan?',
        options: [
          'More app servers, since the writes queue up in them waiting for the database',
          'More read replicas, so the primary spends less time serving reads',
          'A higher peak factor, so the fleet is sized for spikes above 10,417/sec',
          'Partitioning (sharding) the data, so writes spread across primaries',
        ],
        answer: 3,
        explanation:
          'Writes are the hard constraint because they all land on the primary: at 90% writes, the 11,574 peak requests/sec become 10,417 peak writes/sec. App servers and read replicas do not add write capacity, and only 1,157 reads/sec are left for replicas to take. 10,000 writes/sec is a simplified planning number, not a measured limit - but the estimate is already past it, and every new user pushes it further.',
      },
      {
        id: 'cap-est-7',
        prompt:
          'Peak is 5,000 req/sec and every response is a 1 MB image. Can one server with a 1 Gbit/sec network card serve it?',
        options: [
          'Yes - 1 Gbit/sec is 1,000 MB/sec, so 5,000 MB/sec needs five such servers at most',
          'Yes, if the images are compressed with gzip before they leave the server',
          'No - 5,000 x 1 MB is about 40 Gbit/sec, 40 times one link; use a CDN',
          'Only at the average load of about 1,000 req/sec, not at the evening peak',
        ],
        answer: 2,
        explanation:
          '5,000 x 1 MB = 5,000 MB/sec = 40,000 Mbit/sec. A 1 Gbit/sec link moves about 125 MB/sec, not 1,000 - the tempting answer confuses bits with bytes. Bandwidth is an estimate of its own, and here it decides the design.',
      },
      {
        id: 'cap-est-8',
        prompt:
          'A logging service writes 500 GB a day, keeps logs for 30 days and stores 3 copies. How much storage does it need?',
        options: ['About 15 TB', 'About 45 TB', 'About 550 TB', 'About 1.5 TB'],
        answer: 1,
        explanation:
          '500 GB x 30 days x 3 copies = 45 TB, and it stays there because old logs are deleted as new ones arrive. 550 TB (500 GB x 365 x 3) is what you get if you forget the retention period; 15 TB forgets the copies.',
      },
      {
        id: 'cap-est-9',
        prompt:
          'An internal tool has 2,000 users making 50 requests a day each. The team plans a message queue, a sharded database and twelve microservices. What does the estimate say?',
        options: [
          'Build it all - the traffic will grow into it, and rebuilding under load later costs more',
          'Shard now, because migrating a live database later is slow and risky',
          'Put the API behind a CDN first, so repeated requests never reach the servers',
          'About 1 req/sec on average, maybe 10 at peak - one machine and a spare handle it',
        ],
        answer: 3,
        explanation:
          '2,000 x 50 = 100,000 requests a day / 86,400 = about 1.2 req/sec. Even at 10x peak that is far under one server. An estimate also stops over-engineering: the Lab shows "One machine and a spare" for loads under about 1,000 req/sec.',
      },
      {
        id: 'cap-est-10',
        prompt:
          'The peak is 7,200 req/sec and one app server handles about 1,000. The Lab shows 8 servers needed at peak and 12 with headroom. Why provision 12 rather than 8?',
        options: [
          'Eight has no margin: headroom absorbs a spike or a lost server and keeps latency low',
          'Twelve is a safety habit with no real reason - eight servers already cover the 7,200 peak',
          'Because each server can only use half of its CPU before the OS starts throttling it',
          'Because the read replicas need their own dedicated app servers in front of them',
        ],
        answer: 0,
        explanation:
          '7,200 / 1,000 rounds up to 8 servers running at 90% at the peak. One server failing, or a peak 20% above the estimate, would overload the rest. 50% headroom is a rule of thumb, and the 1,000 req/sec per server is a planning number, not a measurement.',
      },
      {
        id: 'cap-est-11',
        prompt:
          'A product owner says the app will have "somewhere between 1 million and 5 million" daily active users. What should you do with the estimate?',
        options: [
          'Wait until the exact number is known, since a wrong input makes the whole estimate useless',
          'Average them to 3 million and use only that, since the errors cancel out',
          'Run it at both ends: if both land in one category, the exact number does not matter',
          'Multiply 5 million by 10 to be safe, so any launch spike is covered',
        ],
        answer: 2,
        explanation:
          'Estimates pick a category, so an input range is fine: compute both ends. If they land in different categories, that uncertainty is what to resolve first. A single averaged number hides whether the range crosses a boundary (one machine, a fleet, a partitioned fleet). An arbitrary 10x on top only pays for idle capacity.',
      },
      {
        id: 'cap-est-12',
        prompt:
          'Tickets for a concert go on sale at 10:00 sharp. Which peak factor fits the estimate?',
        options: [
          '1x - sales are spread over the weeks before the concert, so the average holds',
          '2x, like a global service, since fans buy from many different time zones',
          '3x, like a normal evening peak, since most fans buy after they finish work',
          '10x or more - a scheduled event squeezes the traffic of hours into minutes',
        ],
        answer: 3,
        explanation:
          'A scheduled event concentrates demand: everyone arrives at 10:00. 2x fits traffic spread across time zones, and 3-5x a normal single-region evening; anything with a start time needs 10x or more, and often a queue in front.',
      },
    ],
  },
  {
    slug: 'back-of-the-envelope',
    title: 'Back-of-the-envelope Calculations',
    tagline: 'Round numbers, powers of ten and a handful of latencies you know by heart.',
    category: 'getting-started',
    difficulty: 'Beginner',
    lab: 'capacity',
    labFocus: 'back-of-the-envelope',
    keywords: ['latency numbers', 'estimation', 'napkin math', 'powers of ten', 'orders of magnitude'],
    what: 'Deliberately rough arithmetic - numbers rounded to powers of ten, plus a small set of memorised latency and size constants - that lets you sanity-check a design in seconds, without benchmarks.',
    why: 'If you know a disk seek (~10 ms) is roughly 100,000x slower than a memory reference (~100 ns), you can reject a design in your head instead of discovering the problem in production. Rounding makes the arithmetic fast enough to do in a meeting.',
    how: [
      'Round big numbers to powers of ten and multiply by adding exponents: 10^7 users x 10 requests = 10^8 a day.',
      'Round aggressively: 86,400 seconds per day is "about 10^5", so 10^8 a day is about 10^3 per second.',
      'Memorise orders of magnitude, not exact values: memory ~100 ns, SSD ~100 us, datacenter round trip ~0.5 ms, across an ocean ~150 ms.',
      'Always compare the result to one machine: can a single server do this?',
      'If the answer lands near a category boundary, stop rounding and do the exact sum.',
    ],
    diagram: `Approximate latencies (order of magnitude)

L1 cache reference                     ~1 ns
Main memory reference                ~100 ns
SSD random read                      ~100 us
Round trip within a datacenter       ~500 us
Disk seek (spinning)                  ~10 ms
Round trip California -> Netherlands ~150 ms

1 day ~= 86,400 s ~= 10^5 s
10^8 requests/day / 10^5 s = 10^3 req/sec`,
    when: ['During design reviews.', 'Whenever someone says "that should be fast enough".', 'Before a detailed capacity estimate, to know which order of magnitude you are in.'],
    tradeoffs: [
      {
        approach: 'Round, order-of-magnitude arithmetic',
        gains: ['Fast enough to do in an interview or a design review', 'Quickly rules out designs that cannot work, such as one disk for 1 PB'],
        costs: ['Misses constant factors that can matter near a limit', 'Easy to trust a rounded number more than it deserves'],
      },
      {
        approach: 'Exact arithmetic on the same inputs',
        gains: ['Removes rounding error, which matters when the answer sits near a boundary', 'Numbers can go straight into a budget or a purchase order'],
        costs: ['Slower, and needs a calculator in the meeting', 'Precision the inputs do not have - a DAU guess is rarely right to two figures'],
      },
      {
        approach: 'Benchmark or load test instead of estimating',
        gains: ['Real numbers for your hardware, data and code paths', 'Exposes bottlenecks no latency table predicts'],
        costs: ['Takes days of setup rather than minutes', 'Needs a working system, so it cannot guide the first design'],
      },
    ],
    mistakes: [
      'Treating these as benchmarks - they are ratios, and they shift with hardware.',
      'Ignoring the network round trip, usually the dominant term in a distributed call.',
      'Rounding every input the same way, so the errors add up instead of cancelling.',
      'Trusting a rough answer that lands right on a category boundary.',
      'Mixing bits and bytes: 1 Gbit/sec is about 125 MB/sec, not 1,000.',
    ],
    related: ['capacity-estimation', 'caching', 'cdn'],
    quiz: [
      {
        id: 'botec-1',
        prompt:
          'A request makes 50 random reads, one after another, and must answer within 100 ms. The data sits on SSDs. Does the design fit, and would it fit on spinning disks?',
        options: [
          'It fits on neither: 50 storage reads in a row always add up to seconds',
          'SSD: about 5 ms, fits. Spinning disk: 50 x 10 ms seeks = 500 ms, too slow',
          'It fits on both, since each read takes microseconds on either kind of disk',
          'SSD: about 500 ms, too slow; spinning disk is fine because reads are sequential',
        ],
        answer: 1,
        explanation:
          'An SSD random read is about 100 us, so 50 x 100 us = 5 ms. A spinning-disk seek is about 10 ms, so 50 x 10 ms = 500 ms. Knowing the two orders of magnitude settles it in seconds - the reads here are random, so the sequential-read argument does not apply. In the Speed view of the Lab, set 50 database calls with 0% of reads in RAM, then switch a miss from SSD to Spinning disk: the storage line goes from 5 ms to 500 ms.',
      },
      {
        id: 'botec-2',
        prompt:
          'A checkout page in Europe calls a pricing service in the US once per cart item, one call after another. Carts hold 30 items and the page budget is 500 ms. What do you tell the team?',
        options: [
          'Fine - inside a modern cloud, network calls take well under a millisecond each',
          'Make the pricing service code faster, since each call spends its time there',
          'About 30 x 150 ms = 4.5 s: batch the items into one call or cache prices nearby',
          'Add more pricing servers so each call waits less in the queue',
        ],
        answer: 2,
        explanation:
          'A transatlantic round trip is about 150 ms, set by distance, not by server speed, so 30 calls take 4.5 s - nine times the budget. Faster code or more servers do not shorten the trip. Removing round trips (one batched call) or shortening the distance (a local cache) is the only fix. In the Speed view of the Lab, put the user on another continent and set 30 calls from the user: the round trips alone come to 4.5 s, and one call brings them back to 150 ms.',
      },
      {
        id: 'botec-3',
        prompt:
          'In the Size view of the Lab, with rounding on, 12M users x 8 requests becomes 10^7 x 10. The rough peak is 5,000 req/sec and the exact one is 5,556. What does the "1.1x" in the Rough against exact table mean for the design?',
        options: [
          'The rough answer is 10% off, so it must be redone with exact numbers before any design',
          'Both land in one category, a fleet behind a load balancer, so the design is the same',
          'The rough answer always underestimates, so add 10% to every number it produces',
          'The gap is 1.1 orders of magnitude, so the design moves up one category',
        ],
        answer: 1,
        explanation:
          'Rounding only has to get the category right, and a 1.1x gap is far inside one order of magnitude. Rough answers are not always low - 12M rounded down while 8 rounded up, and those errors partly cancelled.',
      },
      {
        id: 'botec-4',
        prompt:
          'A teammate objects that dividing by 10^5 seconds instead of 86,400 is "wrong". How big is that error, and does it matter?',
        options: [
          'About 14% low - far inside the error of a DAU guess, so it changes no decision',
          'About 10x, because 10^5 has one more digit than 86,400, so it must never be done',
          'No error at all - a day is 100,000 seconds once you round the hours',
          'About 50% - acceptable in interviews, but never in a real capacity plan',
        ],
        answer: 0,
        explanation:
          '86,400 / 100,000 = 0.86, so the rate comes out about 14% low. User counts are often guesses that are off by 2x or more, so 14% never moves an estimate into a different category. It is a real error, just an unimportant one.',
      },
      {
        id: 'botec-5',
        prompt:
          'In the Size view of the Lab, with rounding on, move Requests per user to 20 and Average object size to 2 KB. Rough against exact now puts stored data about 4x below exact, where it was about 1x. What happened?',
        options: [
          'Rounding to powers of ten is always about 4x off; the earlier 1x match was luck',
          'The replication factor of 3 is ignored in rough mode, which removes most of the total',
          'Rough mode uses 1,024 bytes per KB, and that difference compounds over a year of data',
          'Users, requests and size all rounded down, so the errors multiplied, not cancelled',
        ],
        answer: 3,
        explanation:
          '12M became 10^7, 20 requests became 10 and 2 KB became 1 KB: three roundings down, by 1.2x, 2x and 2x, multiply to almost 5x (365 days rounding up to 400 wins a little back). With 8 requests and 1.2 KB, 8 rounded up and the errors cancelled. Move Requests per user to 40, which rounds up to 100, and the gap falls to about 1.1x. When every input rounds the same way, check the exact sum.',
      },
      {
        id: 'botec-6',
        prompt:
          'The rough estimate says 800 peak req/sec, which would mean one machine and a spare. The exact sum says 1,300, which means a fleet. What should you do?',
        options: [
          'Trust the rough number - that is the point of rounding, and it is usually close',
          'Trust whichever number is cheaper, and scale up later if traffic proves it wrong',
          'Treat it as a boundary case: firm up the inputs and do the exact arithmetic',
          'Average them to 1,050 and pick the fleet, to split the difference',
        ],
        answer: 2,
        explanation:
          'Rounding is safe when the answer is far from a boundary; here the rough and exact answers land in different categories, so precision now matters. The Lab flags this case in its insight. Picking the cheaper number ignores the evidence.',
      },
      {
        id: 'botec-7',
        prompt: 'A backup job must copy 500 MB every second over 1 Gbit/sec links. How many links does it need, at minimum?',
        options: [
          'One, with room to spare - a 1 Gbit/sec link moves 1,000 MB/sec',
          'About four - each 1 Gbit/sec link moves about 125 MB/sec',
          'Forty, since 500 MB/sec is about 40 Gbit/sec once you convert',
          'Half a link - a gigabit link carries about a gigabyte a second',
        ],
        answer: 1,
        explanation:
          'Divide bits by 8: 1 Gbit/sec is about 125 MB/sec, so 500 MB/sec (4 Gbit/sec, not 40) needs about four links, more with protocol overhead. Reading Gbit as GB is the classic 8x mistake. In the Speed view of the Lab, set Response size to 500 MB: one 1 Gbit/s link needs about 4 s to move it, so one second of it needs four links.',
      },
      {
        id: 'botec-8',
        prompt:
          'A write must be stored in Europe and in the US before the user sees "saved". The servers are fast and idle. Roughly what is the lowest possible time for that write?',
        options: [
          'About 1 ms - fast, idle servers answer at once, and light in fibre is nearly instant',
          'About 10 ms, the cost of one disk seek on each side of the ocean',
          'About 1 second, since two regions must agree before confirming',
          'At least one transatlantic round trip, roughly 70-150 ms',
        ],
        answer: 3,
        explanation:
          'Light in fibre covers roughly 200 km per millisecond, and the path is never straight, so a round trip between Europe and the US costs tens to a hundred-plus milliseconds. No hardware upgrade removes it; only avoiding the synchronous cross-region wait does. In the Speed view of the Lab, put the user on another continent and every read in RAM: the request still never drops below about 150 ms.',
      },
      {
        id: 'botec-9',
        prompt:
          'A page loads a list of 200 items, then runs one database query per item. The database is in the same datacenter. What does the arithmetic say?',
        options: [
          'About 200 x 0.5 ms = 100 ms of round trips; batch them into one query',
          'Nothing to worry about - in the same datacenter round trips are effectively free',
          'About 200 ns, since the database serves these rows from memory, not disk',
          'About 30 seconds, since each query pays a full connection and login setup',
        ],
        answer: 0,
        explanation:
          'A round trip within a datacenter is about 0.5 ms, so 200 of them are about 100 ms before the database does any work. That is the N+1 query problem: the cost is the number of trips, which is why batching beats faster code. In the Speed view of the Lab, keep the user in the same region and set 200 database calls: the datacenter hops come to 100 ms and dominate the request.',
      },
      {
        id: 'botec-10',
        prompt:
          'A cache answers 90% of reads from memory (~100 ns) and the rest go to SSD (~100 us). Which part dominates the average read time?',
        options: [
          'The hits, because there are nine times more of them in every batch of reads',
          'Both contribute equally, since the hit rate offsets the misses',
          'The misses: 10% x 100 us = 10 us, against 0.09 us for all the hits',
          'Neither - the average is simply 100 ns, because the cache hides the SSD',
        ],
        answer: 2,
        explanation:
          'SSD is about 1,000x slower than memory, so the 10% of misses cost far more than the 90% of hits: 10 us against 0.09 us. Raising the hit rate from 90% to 99% cuts the average almost tenfold. In the Speed view of the Lab, Reads found in RAM starts at 90%: the SSD line is 10 us against 90 ns for RAM, and 99% takes the average read from about 10 us to 1.1 us.',
      },
      {
        id: 'botec-11',
        prompt:
          'A manager says: "We will get a million requests a day - surely we need a cluster?" What does a ten-second estimate say?',
        options: [
          'Yes - a million requests a day is more than one server can reliably take',
          'About 10 req/sec on average, 100 at peak - one machine and a spare handle it',
          'About 1 million req/sec at peak, so a large cluster behind a load balancer',
          'It cannot be known without a load test on production-sized hardware and data',
        ],
        answer: 1,
        explanation:
          '10^6 requests / 10^5 seconds = 10 req/sec; even a 10x peak is 100 req/sec, far below what one server does. "A million" sounds large only until it is normalised to per-second.',
      },
    ],
  },
  {
    slug: 'what-happens-when-you-type-a-url',
    title: 'What Happens When You Type a URL?',
    tagline: 'One request, a dozen systems - the guided tour of the whole stack.',
    category: 'getting-started',
    difficulty: 'Beginner',
    lab: 'url-journey',
    labFocus: 'what-happens-when-you-type-a-url',
    keywords: ['dns', 'tcp', 'tls', 'cdn', 'rendering', 'journey'],
    what: 'A step-by-step walk through everything that happens between pressing Enter and seeing a rendered page: name resolution, connection setup, encryption, caching layers, the backend, and rendering.',
    why: 'It is the single best map of how the pieces relate. Almost every other concept in system design appears somewhere along this path.',
    how: [
      'The browser checks its caches, then resolves the hostname through DNS.',
      'A TCP connection is opened (or reused), then TLS negotiates encryption.',
      'The HTTP request may be answered by a CDN edge without reaching your origin at all.',
      'At the origin, a load balancer picks a server, which checks a cache before querying the database.',
      'The response travels back and the browser parses, lays out and paints it.',
    ],
    when: [
      'As the map: almost every other Concept sits somewhere on this path.',
      'When a page is slow: find which stage the time goes to before optimising any one of them.',
      'In a design interview, as the first sketch of the request path.',
    ],
    advantages: [
      'Shows that connection setup and rendering often cost more than the server code.',
      'Shows every place a request can be answered early: browser cache, DNS cache, CDN, application cache.',
    ],
    diagram: `Browser -> DNS -> TCP -> TLS -> HTTP request
   -> CDN edge (hit? done)
   -> Load Balancer -> Backend -> Cache -> Database
   -> HTTP response -> parse, layout, paint`,
    tradeoffs: [
      {
        approach: 'Keep connections and DNS answers warm (keep-alive, DNS caching, TLS resumption)',
        gains: ['Later requests skip the DNS lookup and TCP and TLS handshakes', 'Cuts several round trips from every repeat visit'],
        costs: ['Cached DNS answers delay failover to a new address until the TTL expires', 'Open connections hold memory and file descriptors on both ends'],
      },
      {
        approach: 'Serve the first byte from a nearby CDN edge',
        gains: ['Handshakes finish over a short round trip instead of a cross-continent one', 'Cached static assets are served without a trip to the origin'],
        costs: ['Another layer to configure, pay for and debug', 'Stale content until caches expire or are purged'],
      },
    ],
    mistakes: [
      'Assuming the server is the slow part - DNS, connection setup and rendering often dominate.',
      'Forgetting that the first request on a cold connection pays DNS + TCP + TLS before any work starts.',
    ],
    related: ['dns', 'http-https', 'tls-https', 'cdn', 'load-balancing', 'caching'],
    quiz: [
      {
        id: 'url-1',
        prompt:
          'A user opens your page and waits 400 ms. A few seconds later they click a link to another page on the same site, and it takes 150 ms. Same server, same code. What explains most of the difference?',
        options: [
          'The server was still warming up its caches during the first request',
          'The second page is smaller, so it had fewer bytes to send over the wire',
          'The first paid for DNS, TCP and TLS setup; the second reused the open connection',
          'The browser rendered the second page from its cache without asking the server',
        ],
        answer: 2,
        explanation:
          'A new connection pays DNS + TCP + TLS before the request is even sent; a reused one skips all three. In the Lab, turn Warm connection on and watch those stages turn to skipped. The server warming up is the tempting answer, but the Lesson shows the setup cost alone is often 150 ms or more.',
      },
      {
        id: 'url-2',
        prompt:
          'Your only origin is in Virginia. Users in Singapore see slow first loads, although the handler takes 30 ms. Which change cuts their time the most?',
        options: [
          'Put a CDN in front, so handshakes and static files are served from a nearby edge',
          'Add a database index on the hottest query, since the database is usually the slow part',
          'Double the number of app servers so each request waits less in the queue',
          'Move from TLS 1.3 back to TLS 1.2, which older phones in the region handle faster',
        ],
        answer: 0,
        explanation:
          'Every handshake costs a full round trip, and the round trip to Virginia is the big number. In the Lab, set the round trip to the origin to 200 ms and toggle the CDN: the TCP and TLS stages drop to the 10 ms edge round trip. An index or more servers only touch the 30 ms of backend work, and TLS 1.2 adds a round trip instead of removing one.',
      },
      {
        id: 'url-3',
        prompt:
          'A cold page load takes 1.2 s. Profiling shows your server code runs for 40 ms. The team plans a sprint to make the handler twice as fast. What should you say?',
        options: [
          'Good plan - the handler is the only part of the load the team actually controls',
          'Make the database faster first, since it is always the slowest part of a request',
          'Buy bigger servers instead, it is quicker than a sprint',
          'It saves 20 ms of 1,200; the handshakes, transfer and rendering hold the time',
        ],
        answer: 3,
        explanation:
          'The worked example in the Lesson is exactly this: 40 ms of server time in about 1.19 s. Halving the handler saves under 2 percent, while a CDN and a smaller JavaScript bundle save more than half. "The handler is the only part we control" is wrong - you control connection reuse, the CDN, cache headers and the bundle too.',
      },
      {
        id: 'url-4',
        prompt:
          'After a deploy the cache hit rate drops from 95% to 50%. What does the path of a request that misses look like now?',
        options: [
          'Load balancer, app server, then an error, because the cache had nothing to return',
          'Load balancer, app server, cache miss, database, then the cache is filled',
          'Load balancer straight to the database, skipping the app server and its cache',
          'CDN edge, then the database directly',
        ],
        answer: 1,
        explanation:
          'A miss is not an error: the app server asks the cache, and on a miss it queries the database and fills the cache for the next request. In the Lab, turn Cache hit off and the Database query stage appears. Half the requests now pay the 35 ms query, which is why the drop hurts.',
      },
      {
        id: 'url-5',
        prompt:
          'A page loads fonts, scripts and images from eight different domains. Every one of those servers answers in under 10 ms, yet the page is slow on a first visit. Why?',
        options: [
          'Browsers can only download one file at a time, so the eight domains wait in line',
          'The servers must be overloaded at peak, even if their idle answers are fast',
          'Each new domain needs its own DNS lookup and TCP and TLS handshakes first',
          'Images are always slower than HTML, since they are far larger files to decode',
        ],
        answer: 2,
        explanation:
          'Connection setup is paid per origin. Eight domains means up to eight lookups and sixteen handshake round trips on a cold visit, and no server optimisation can remove them. Serving from fewer origins, and reusing one connection with HTTP/2, removes them. The servers being overloaded does not fit: each one answers in under 10 ms.',
      },
      {
        id: 'url-6',
        prompt:
          'A user on cafe Wi-Fi types example.com without https:// for the first time. Your site redirects HTTP to HTTPS. What is the risk, and what closes it?',
        options: [
          'The first request is plain HTTP and can be intercepted; HSTS with preload closes it',
          'There is no risk, because the redirect happens before any form data or cookies are sent',
          'The risk is DNS spoofing on the Wi-Fi, and a shorter TTL on the record closes it',
          'The risk is the CDN reading traffic, and turning the CDN off closes it',
        ],
        answer: 0,
        explanation:
          'The browser only learns about HTTPS from the redirect, and that redirect arrives over plain HTTP that anyone on the Wi-Fi can read or replace. HSTS tells the browser to never try plain HTTP again, and preloading ships that rule inside the browser, so even the first visit is protected. "No risk" is wrong because the request carrying the redirect is itself unprotected.',
      },
      {
        id: 'url-7',
        prompt:
          'A CDN sits in front of your site. Which requests does the edge answer on its own, without contacting your origin?',
        options: [
          'Every request, because the edge keeps a full copy of the site',
          'None - a CDN only speeds up the network path, it never answers on its own',
          'Only POST requests, since they can be accepted and queued at the edge',
          'Cacheable files it already holds; pages built per user go to the origin',
        ],
        answer: 3,
        explanation:
          'The edge can only answer with a response it may cache and has cached. A personalised page has to come from your servers, so the edge forwards it - that is the "miss, forward" you see on the CDN edge in the Lab. It still helps that page, because the handshakes end at the nearby edge.',
      },
      {
        id: 'url-8',
        prompt:
          'You moved the site to a new server and updated the A record an hour ago. Some users still reach the old server. At which stage of the journey does that happen?',
        options: [
          'The TLS handshake, because the old certificate is still valid and pins the old server',
          'DNS resolution: resolvers still hold the old answer until its TTL runs out',
          'The load balancer, because it still routes to the old server until it is restarted',
          'Rendering, because the browser cached the old page and shows it without asking',
        ],
        answer: 1,
        explanation:
          'Nothing is pushed to DNS caches. Each one keeps the old address until the TTL of the record runs out, so a 24-hour TTL can mean a day of traffic to the old server. The certificate is the tempting answer, but it does not choose which address the browser connects to - DNS does.',
      },
      {
        id: 'url-9',
        prompt:
          'A user reports that your site does not load and their browser says the name could not be resolved. From your office, the site works. Which part of the journey failed for them?',
        options: [
          'DNS resolution - their browser never got an IP address to connect to',
          'The TLS handshake, because their network blocks your certificate authority',
          'The database, since it rejects queries coming from their country or region',
          'Rendering, because their browser cannot run your large JavaScript bundle',
        ],
        answer: 0,
        explanation:
          'A name that cannot be resolved stops the journey at the first network stage: no address, so no TCP, no TLS and no request. Your servers saw nothing, which is why they look healthy. A TLS failure would show a certificate or connection error instead, after the address was found.',
      },
      {
        id: 'url-10',
        prompt: 'In the Lab, with the CDN on, where does the TLS connection of the browser end?',
        options: [
          'At the app server, since only the app server holds the private key',
          'At the database, so the data stays encrypted all the way end to end',
          'At the load balancer, always, since it terminates TLS for the site',
          'At the CDN edge, which holds a certificate for your domain',
        ],
        answer: 3,
        explanation:
          'The browser handshakes with whatever it connects to, and with a CDN that is the edge. That is why the TLS stage costs the 10 ms edge round trip, not the origin round trip. With the CDN off, the load balancer shows "ends here" instead - so "always the load balancer" is only true without a CDN.',
      },
    ],
  },
];
